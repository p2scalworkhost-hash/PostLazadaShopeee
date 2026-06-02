/**
 * TikTok & Instagram Fetcher - Cloudflare Worker + R2
 *
 * Endpoints:
 *   POST   /api/preview        - ดูตัวอย่างคลิป (ไม่บันทึก)
 *   POST   /api/fetch          - ดึงคลิป → เก็บใน R2
 *   GET    /api/clips          - รายการคลิปทั้งหมด
 *   GET    /api/clips/:id      - ข้อมูล metadata ของคลิป
 *   GET    /api/clips/:id/video - สตรีมวิดีโอจาก R2
 *   DELETE /api/clips/:id      - ลบคลิป
 *
 * Supported Sources:
 *   - TikTok (via TikWM API)
 *   - Instagram Reels (via direct page scraping)
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ─── CORS ───
    if (request.method === 'OPTIONS') {
      return corsResponse(env, new Response(null, { status: 204 }));
    }

    try {
      // ─── Routes ───
      if (path === '/api/preview' && request.method === 'POST') {
        return corsResponse(env, await handlePreview(request));
      }

      if (path === '/api/scrape-product' && request.method === 'POST') {
        return corsResponse(env, await handleScrapeProduct(request));
      }

      if (path === '/api/proxy-video' && request.method === 'GET') {
        return corsResponse(env, await handleProxyVideo(request));
      }

      if (path === '/api/fetch' && request.method === 'POST') {
        return corsResponse(env, await handleFetch(request, env));
      }

      if (path === '/api/clips' && request.method === 'GET') {
        return corsResponse(env, await handleList(env));
      }

      const clipMatch = path.match(/^\/api\/clips\/([a-zA-Z0-9_-]+)$/);
      if (clipMatch) {
        const id = clipMatch[1];
        if (request.method === 'GET') {
          return corsResponse(env, await handleGetClip(id, env));
        }
        if (request.method === 'DELETE') {
          return corsResponse(env, await handleDelete(id, env));
        }
      }

      const videoMatch = path.match(/^\/api\/clips\/([a-zA-Z0-9_-]+)\/video$/);
      if (videoMatch) {
        return corsResponse(env, await handleStreamVideo(videoMatch[1], env, request));
      }

      // ─── Health Check ───
      if (path === '/' || path === '/api/health') {
        return corsResponse(env, json({ status: 'ok', service: 'TikTok & IG Fetcher Worker', timestamp: new Date().toISOString() }));
      }

      return corsResponse(env, json({ error: 'Not Found' }, 404));

    } catch (err) {
      console.error('Worker error:', err);
      return corsResponse(env, json({ error: err.message || 'Internal Server Error' }, 500));
    }
  }
};


// ═══════════════════════════════════════════
// URL SOURCE DETECTION
// ═══════════════════════════════════════════

/**
 * Detect video source from URL
 * Returns: 'tiktok' | 'instagram' | 'unknown'
 */
function detectSource(url) {
  const u = url.toLowerCase();
  if (u.includes('tiktok.com') || u.includes('tiktok') || u.includes('vm.tiktok') || u.includes('vt.tiktok')) {
    return 'tiktok';
  }
  if (u.includes('instagram.com') || u.includes('instagr.am')) {
    return 'instagram';
  }
  return 'unknown';
}


// ═══════════════════════════════════════════
// HANDLERS
// ═══════════════════════════════════════════

/**
 * POST /api/preview
 * รับ { tiktokUrl } → ตรวจจับแหล่งที่มา → ดึงข้อมูล → ส่งกลับข้อมูล + preview URL
 */
async function handlePreview(request) {
  const body = await request.json();
  const clipUrl = body.tiktokUrl?.trim();

  if (!clipUrl) {
    return json({ error: 'กรุณาระบุลิงก์คลิป' }, 400);
  }

  const source = detectSource(clipUrl);

  if (source === 'tiktok') {
    return await previewTikTok(clipUrl);
  } else if (source === 'instagram') {
    return await previewInstagram(clipUrl);
  } else {
    // Default: try TikTok first (supports some short URLs)
    try {
      return await previewTikTok(clipUrl);
    } catch {
      return json({ error: 'ไม่รองรับ URL นี้ กรุณาใช้ลิงก์ TikTok หรือ Instagram Reel' }, 400);
    }
  }
}

/**
 * Preview: TikTok via TikWM
 */
async function previewTikTok(clipUrl) {
  const tiktokData = await fetchTikTokData(clipUrl);
  const data = tiktokData.data;

  const videoUrl = getBestVideoUrl(data);
  if (!videoUrl) {
    return json({ error: 'ไม่พบ URL วิดีโอจาก TikWM' }, 502);
  }

  return json({
    success: true,
    preview: {
      tiktokUrl: clipUrl,
      source: 'tiktok',
      title: data.title || '',
      duration: data.duration || 0,
      videoUrl: videoUrl,
      coverUrl: data.cover || data.origin_cover || '',
      author: {
        nickname: data.author?.nickname || '',
        uniqueId: data.author?.unique_id || '',
        avatar: data.author?.avatar || ''
      },
      stats: {
        plays: data.play_count || 0,
        likes: data.digg_count || 0,
        comments: data.comment_count || 0,
        shares: data.share_count || 0,
        collects: data.collect_count || 0
      }
    }
  });
}

/**
 * Preview: Instagram Reel
 */
async function previewInstagram(clipUrl) {
  const igData = await fetchInstagramData(clipUrl);

  return json({
    success: true,
    preview: {
      tiktokUrl: clipUrl,
      source: 'instagram',
      title: igData.title || '',
      duration: igData.duration || 0,
      videoUrl: igData.videoUrl,
      coverUrl: igData.coverUrl || '',
      author: {
        nickname: igData.author?.nickname || '',
        uniqueId: igData.author?.uniqueId || '',
        avatar: igData.author?.avatar || ''
      },
      stats: {
        plays: igData.stats?.plays || 0,
        likes: igData.stats?.likes || 0,
        comments: igData.stats?.comments || 0,
        shares: 0,
        collects: 0
      }
    }
  });
}


/**
 * POST /api/fetch
 * รับ { tiktokUrl, productUrl } → ดึงข้อมูลจากแหล่งที่ตรวจจับ → ดาวน์โหลด MP4 → อัปโหลดไป R2
 */
async function handleFetch(request, env) {
  const body = await request.json();
  const clipUrl = body.tiktokUrl?.trim();
  const productUrl = body.productUrl?.trim() || '';
  const productName = body.productName?.trim() || '';
  const platform = body.platform?.trim() || '';
  const note = body.note?.trim() || '';
  const customTitle = body.title?.trim() || '';

  if (!clipUrl) {
    return json({ error: 'กรุณาระบุลิงก์คลิป' }, 400);
  }

  const source = detectSource(clipUrl);
  let videoUrl, extractedData;

  if (source === 'instagram') {
    // ─── Instagram Reel ───
    const igData = await fetchInstagramData(clipUrl);
    videoUrl = igData.videoUrl;
    extractedData = {
      title: igData.title || '',
      duration: igData.duration || 0,
      author: igData.author || { nickname: '', uniqueId: '', avatar: '' },
      stats: igData.stats || { plays: 0, likes: 0, comments: 0, shares: 0, collects: 0 }
    };
  } else {
    // ─── TikTok (default) ───
    const tiktokData = await fetchTikTokData(clipUrl);
    const data = tiktokData.data;
    videoUrl = getBestVideoUrl(data);
    extractedData = {
      title: data.title || '',
      duration: data.duration || 0,
      author: {
        nickname: data.author?.nickname || '',
        uniqueId: data.author?.unique_id || '',
        avatar: data.author?.avatar || ''
      },
      stats: {
        plays: data.play_count || 0,
        likes: data.digg_count || 0,
        comments: data.comment_count || 0,
        shares: data.share_count || 0,
        collects: data.collect_count || 0
      }
    };
  }

  if (!videoUrl) {
    return json({ error: 'ไม่พบ URL วิดีโอ' }, 502);
  }

  // 3) ดาวน์โหลดวิดีโอ
  const videoRes = await fetch(videoUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': source === 'instagram' ? 'https://www.instagram.com/' : 'https://www.tiktok.com/'
    }
  });

  if (!videoRes.ok) {
    return json({ error: `ดาวน์โหลดวิดีโอไม่สำเร็จ: ${videoRes.status}` }, 502);
  }

  const videoBuffer = await videoRes.arrayBuffer();
  const videoSize = videoBuffer.byteLength;

  // 4) สร้าง ID & Metadata
  const clipId = generateId();
  const now = new Date().toISOString();

  const metadata = {
    id: clipId,
    tiktokUrl: clipUrl,
    source: source,
    productUrl: productUrl,
    productName: productName,
    platform: platform,
    note: note,
    title: customTitle || extractedData.title,
    duration: extractedData.duration,
    author: extractedData.author,
    stats: extractedData.stats,
    fileSize: videoSize,
    createdAt: now,
    status: 'saved'
  };

  // 5) อัปโหลดวิดีโอไป R2
  await env.CLIPS_BUCKET.put(`clips/${clipId}.mp4`, videoBuffer, {
    httpMetadata: {
      contentType: 'video/mp4',
    },
    customMetadata: {
      clipId: clipId,
      source: source,
      title: metadata.title.substring(0, 200),
      createdAt: now
    }
  });

  // 6) อัปโหลด metadata ไป R2
  await env.CLIPS_BUCKET.put(`meta/${clipId}.json`, JSON.stringify(metadata, null, 2), {
    httpMetadata: {
      contentType: 'application/json',
    }
  });

  // 7) อัปเดต index
  await updateIndex(env, clipId, {
    id: clipId,
    source: source,
    title: metadata.title.substring(0, 400),
    author: metadata.author.nickname,
    productUrl: productUrl,
    productName: productName,
    platform: platform,
    note: note,
    duration: metadata.duration,
    fileSize: videoSize,
    createdAt: now,
    status: 'saved'
  });

  return json({
    success: true,
    clip: metadata,
    videoUrl: `/api/clips/${clipId}/video`,
    message: 'ดึงคลิปและบันทึกสำเร็จ!'
  });
}


/**
 * GET /api/clips
 * รายการคลิปทั้งหมด
 */
async function handleList(env) {
  const indexObj = await env.CLIPS_BUCKET.get('index.json');

  if (!indexObj) {
    return json({ clips: [], total: 0 });
  }

  const index = await indexObj.json();
  // เรียงจากใหม่ไปเก่า
  index.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return json({ clips: index, total: index.length });
}


/**
 * GET /api/clips/:id
 * ข้อมูล metadata ของคลิป
 */
async function handleGetClip(id, env) {
  const metaObj = await env.CLIPS_BUCKET.get(`meta/${id}.json`);

  if (!metaObj) {
    return json({ error: 'ไม่พบคลิปนี้' }, 404);
  }

  const metadata = await metaObj.json();
  metadata.videoUrl = `/api/clips/${id}/video`;

  return json(metadata);
}


/**
 * GET /api/clips/:id/video
 * สตรีมวิดีโอจาก R2 (รองรับ Range requests)
 */
async function handleStreamVideo(id, env, request) {
  const obj = await env.CLIPS_BUCKET.get(`clips/${id}.mp4`, {
    range: request.headers,
  });

  if (!obj) {
    return json({ error: 'ไม่พบไฟล์วิดีโอ' }, 404);
  }

  const headers = new Headers();
  headers.set('Content-Type', 'video/mp4');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', 'public, max-age=86400');

  if (obj.range) {
    headers.set('Content-Range', `bytes ${obj.range.offset}-${obj.range.offset + obj.range.length - 1}/${obj.size}`);
    headers.set('Content-Length', obj.range.length);
    return new Response(obj.body, { status: 206, headers });
  }

  headers.set('Content-Length', obj.size);
  return new Response(obj.body, { status: 200, headers });
}


/**
 * DELETE /api/clips/:id
 * ลบคลิปออกจาก R2
 */
async function handleDelete(id, env) {
  // ลบไฟล์วิดีโอ
  await env.CLIPS_BUCKET.delete(`clips/${id}.mp4`);
  // ลบ metadata
  await env.CLIPS_BUCKET.delete(`meta/${id}.json`);
  // อัปเดต index
  await removeFromIndex(env, id);

  return json({ success: true, message: 'ลบคลิปสำเร็จ' });
}


// ═══════════════════════════════════════════
// TIKTOK HELPERS (TikWM API)
// ═══════════════════════════════════════════

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchTikTokData(tiktokUrl) {
  const cacheKey = new Request(`https://cache.local/tiktok?url=${encodeURIComponent(tiktokUrl)}`);
  try {
    const cached = await caches.default.match(cacheKey);
    if (cached) return await cached.json();
  } catch (e) {
    console.warn('TikTok cache read failed:', e?.message || e);
  }

  const providers = [
    { name: 'TikWM', fetcher: fetchTikWM },
    { name: 'Azbry', fetcher: fetchAzbryTikTok }
  ];
  const errors = [];

  for (const provider of providers) {
    try {
      const data = await provider.fetcher(tiktokUrl);
      if (data?.data && getBestVideoUrl(data.data)) {
        data.provider = provider.name;
        try {
          await caches.default.put(cacheKey, new Response(JSON.stringify(data), {
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=21600' }
          }));
        } catch (e) {
          console.warn('TikTok cache write failed:', e?.message || e);
        }
        return data;
      }
      errors.push(`${provider.name}: no video URL`);
    } catch (err) {
      errors.push(`${provider.name}: ${err.message || err}`);
      console.log(`TikTok provider failed (${provider.name}):`, err.message || err);
    }
  }

  throw new Error(`All TikTok providers failed. ${errors.join(' | ')}`);
}

/**
 * เรียก TikWM API และ return parsed data (พร้อมระบบ Retry แบบ Random Jitter Backoff เมื่อเจอ Rate Limit)
 */
async function fetchTikWM(tiktokUrl) {
  const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(tiktokUrl)}`;
  const maxAttempts = 4;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const tikwmRes = await fetch(apiUrl, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
      });

      if (!tikwmRes.ok) {
        throw new Error(`TikWM API error: ${tikwmRes.status}`);
      }

      const tikwmData = await tikwmRes.json();

      if (tikwmData.code !== 0 || !tikwmData.data) {
        const errorMsg = tikwmData.msg || 'ไม่สามารถดึงข้อมูลคลิปจาก TikWM ได้';
        // ตรวจสอบว่าเป็นข้อผิดพลาดจาก Rate Limit (1 request/second)
        if (errorMsg.includes('Limit') || errorMsg.includes('request/second') || tikwmData.code === -1) {
          if (attempt < maxAttempts) {
            console.log(`TikWM rate limit hit: "${errorMsg}". Retrying in 1.5s (attempt ${attempt}/${maxAttempts})...`);
            await sleep(1500 + Math.random() * 500); // ดีเลย์ 1.5 - 2 วินาที (Jitter) เพื่อหลบเลี่ยงการชนกันของคิว
            continue;
          }
        }
        throw new Error(errorMsg);
      }

      return tikwmData;
    } catch (err) {
      if (attempt === maxAttempts) {
        throw err;
      }
      console.log(`TikWM fetch error: ${err.message}. Retrying in 1.5s (attempt ${attempt}/${maxAttempts})...`);
      await sleep(1500 + Math.random() * 500);
    }
  }
}

/**
 * หา Video URL ที่ดีที่สุดจาก TikWM data
 */
async function fetchAzbryTikTok(tiktokUrl) {
  const apiUrl = `https://api.azbry.com/api/download/tiktok?url=${encodeURIComponent(tiktokUrl)}`;
  const res = await fetch(apiUrl, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
  });

  if (!res.ok) {
    throw new Error(`Azbry API error: ${res.status}`);
  }

  const payload = await res.json();
  if (!payload.status || !payload.result) {
    throw new Error(payload.message || 'Azbry did not return TikTok data');
  }

  const result = payload.result;
  const links = Array.isArray(result.links) ? result.links : [];
  return {
    code: 0,
    msg: 'success',
    data: {
      title: result.title || '',
      duration: result.duration || 0,
      hdplay: links[0] || '',
      play: links[1] || links[0] || '',
      wmplay: links[2] || '',
      cover: result.thumbnail || '',
      origin_cover: result.thumbnail || '',
      author: {
        nickname: result.author || '',
        unique_id: '',
        avatar: ''
      },
      play_count: 0,
      digg_count: 0,
      comment_count: 0,
      share_count: 0,
      collect_count: 0
    }
  };
}

function getBestVideoUrl(data) {
  if (data.hdplay) {
    return data.hdplay.startsWith('http') ? data.hdplay : `https://www.tikwm.com${data.hdplay}`;
  }
  if (data.play) {
    return data.play.startsWith('http') ? data.play : `https://www.tikwm.com${data.play}`;
  }
  return '';
}


// ═══════════════════════════════════════════
// INSTAGRAM HELPERS (Direct Page Scraping)
// ═══════════════════════════════════════════

/**
 * Normalize Instagram URL to full format
 */
function normalizeInstagramUrl(url) {
  // Handle shortened instagr.am links
  let normalUrl = url.replace('instagr.am', 'www.instagram.com');
  // Ensure https
  if (!normalUrl.startsWith('http')) {
    normalUrl = 'https://' + normalUrl;
  }
  return normalUrl;
}

/**
 * Extract Instagram Reel/Post shortcode from URL
 */
function extractIGShortcode(url) {
  // Match patterns like /reel/XXXX/, /p/XXXX/, /reels/XXXX/
  const match = url.match(/\/(reel|p|reels|tv)\/([A-Za-z0-9_-]+)/);
  return match ? match[2] : null;
}

/**
 * ดึงข้อมูล Instagram Reel/Post
 * ใช้วิธี scrape จาก Instagram embed page + oembed API
 */
async function fetchInstagramData(igUrl) {
  const normalUrl = normalizeInstagramUrl(igUrl);
  const shortcode = extractIGShortcode(normalUrl);

  if (!shortcode) {
    throw new Error('ไม่สามารถแยก shortcode จาก URL Instagram ได้ กรุณาตรวจสอบลิงก์');
  }

  // ─── Strategy 1: Try IG oEmbed API (for metadata) ───
  let title = '';
  let authorName = '';
  let authorUsername = '';
  let thumbnailUrl = '';

  try {
    const oembedUrl = `https://www.instagram.com/api/v1/oembed/?url=${encodeURIComponent(normalUrl)}`;
    const oembedRes = await fetch(oembedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    if (oembedRes.ok) {
      const oembed = await oembedRes.json();
      title = oembed.title || '';
      authorName = oembed.author_name || '';
      authorUsername = oembed.author_name || '';
      thumbnailUrl = oembed.thumbnail_url || '';
    }
  } catch (e) {
    console.log('oEmbed fetch failed (non-critical):', e.message);
  }

  // ─── Strategy 2: Fetch from Instagram embed page to get video URL ───
  let videoUrl = '';

  // Try embed page approach
  try {
    const embedUrl = `https://www.instagram.com/reel/${shortcode}/embed/captioned/`;
    const embedRes = await fetch(embedUrl, {
      headers: {
        'User-Agent': 'Twitterbot/1.0',
        'Accept': 'text/html'
      }
    });

    if (embedRes.ok) {
      const html = await embedRes.text();

      // Extract video URL from embed page
      // Look for video_url in the embedded data
      const videoPatterns = [
        /\\?"video_url\\?":\s*\\?"([^"]+?)\\?"/,
        /"video_url":"([^"]+)"/,
        /video_url\\?":\\?"([^"\\]+)/,
        /"contentUrl":\s*"([^"]+)"/,
        /property="og:video"\s+content="([^"]+)"/,
        /property="og:video:secure_url"\s+content="([^"]+)"/,
        /data-video-url="([^"]+)"/,
        /"src":"(https:\/\/[^"]*\.mp4[^"]*)"/
      ];

      for (const pattern of videoPatterns) {
        const match = html.match(pattern);
        if (match) {
          videoUrl = match[1].replace(/\\u0026/g, '&').replace(/\\/g, '');
          break;
        }
      }

      // Also try to get caption from embed if we don't have one
      if (!title) {
        const captionMatch = html.match(/<div class="Caption"[^>]*>.*?<a[^>]*>([^<]*)<\/a>\s*(.*?)<\/div>/s);
        if (captionMatch) {
          title = (captionMatch[2] || '').replace(/<[^>]*>/g, '').trim().substring(0, 500);
        }
      }

      // Try to extract thumbnail if we don't have it
      if (!thumbnailUrl) {
        const thumbMatch = html.match(/property="og:image"\s+content="([^"]+)"/);
        if (thumbMatch) {
          thumbnailUrl = thumbMatch[1];
        }
      }
    }
  } catch (e) {
    console.log('Embed page fetch failed:', e.message);
  }

  // ─── Strategy 3: Try direct page with __a=1 (graphql endpoint) ───
  if (!videoUrl) {
    try {
      const graphqlUrl = `https://www.instagram.com/p/${shortcode}/?__a=1&__d=dis`;
      const graphqlRes = await fetch(graphqlUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
          'Accept': '*/*',
          'X-IG-App-ID': '936619743392459',
          'X-Requested-With': 'XMLHttpRequest'
        }
      });

      if (graphqlRes.ok) {
        const graphqlData = await graphqlRes.json();
        const item = graphqlData?.items?.[0] || graphqlData?.graphql?.shortcode_media;
        if (item) {
          videoUrl = item.video_url || item.video_versions?.[0]?.url || '';
          if (!title) title = item.caption?.text || item.edge_media_to_caption?.edges?.[0]?.node?.text || '';
          if (!authorName) authorName = item.user?.full_name || item.owner?.full_name || '';
          if (!authorUsername) authorUsername = item.user?.username || item.owner?.username || '';
          if (!thumbnailUrl) thumbnailUrl = item.image_versions2?.candidates?.[0]?.url || item.display_url || '';
        }
      }
    } catch (e) {
      console.log('GraphQL fetch failed:', e.message);
    }
  }

  // ─── Strategy 4: Try alternative third-party API as last resort ───
  if (!videoUrl) {
    try {
      // Use a public downloader API as fallback
      const apiUrl = `https://api.saveig.app/api/ajaxSearch`;
      const formData = new URLSearchParams();
      formData.set('q', normalUrl);
      formData.set('t', 'media');
      formData.set('lang', 'en');

      const apiRes = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Origin': 'https://saveig.app',
          'Referer': 'https://saveig.app/'
        },
        body: formData.toString()
      });

      if (apiRes.ok) {
        const apiData = await apiRes.json();
        if (apiData.data) {
          // Extract video URL from HTML response
          const downloadMatch = apiData.data.match(/href="(https:\/\/[^"]+\.mp4[^"]*)"/);
          if (downloadMatch) {
            videoUrl = downloadMatch[1];
          }
          // Try other href patterns
          if (!videoUrl) {
            const altMatch = apiData.data.match(/href="(https:\/\/[^"]+)"/);
            if (altMatch) {
              videoUrl = altMatch[1];
            }
          }
        }
      }
    } catch (e) {
      console.log('Third-party API fallback failed:', e.message);
    }
  }

  if (!videoUrl) {
    throw new Error('ไม่สามารถดึงวิดีโอจาก Instagram ได้ ลิงก์อาจไม่ใช่ Public หรือ Instagram บล็อกการเข้าถึงชั่วคราว กรุณาลองใหม่อีกครั้ง');
  }

  return {
    videoUrl,
    title: title || '',
    duration: 0,
    coverUrl: thumbnailUrl,
    author: {
      nickname: authorName || authorUsername || '',
      uniqueId: authorUsername || '',
      avatar: ''
    },
    stats: {
      plays: 0,
      likes: 0,
      comments: 0
    }
  };
}


// ═══════════════════════════════════════════
// COMMON HELPERS
// ═══════════════════════════════════════════

function generateId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const timestamp = Date.now().toString(36);
  let random = '';
  for (let i = 0; i < 6; i++) {
    random += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${timestamp}_${random}`;
}

async function updateIndex(env, clipId, entry) {
  let index = [];
  const indexObj = await env.CLIPS_BUCKET.get('index.json');
  if (indexObj) {
    index = await indexObj.json();
  }
  // เพิ่มรายการใหม่ (ไม่ให้ซ้ำ)
  index = index.filter(item => item.id !== clipId);
  index.unshift(entry);

  await env.CLIPS_BUCKET.put('index.json', JSON.stringify(index), {
    httpMetadata: { contentType: 'application/json' }
  });
}

async function removeFromIndex(env, clipId) {
  const indexObj = await env.CLIPS_BUCKET.get('index.json');
  if (!indexObj) return;

  let index = await indexObj.json();
  index = index.filter(item => item.id !== clipId);

  await env.CLIPS_BUCKET.put('index.json', JSON.stringify(index), {
    httpMetadata: { contentType: 'application/json' }
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function handleProxyVideo(request) {
  const url = new URL(request.url).searchParams.get('url');
  if (!url) {
    return json({ error: 'Missing url parameter' }, 400);
  }

  const targetUrl = decodeURIComponent(url);

  // Download video from actual CDN with appropriate headers
  const videoRes = await fetch(targetUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': targetUrl.includes('instagram.com') ? 'https://www.instagram.com/' : 'https://www.tiktok.com/'
    }
  });

  if (!videoRes.ok) {
    return new Response(`Failed to fetch video from CDN: ${videoRes.status}`, { status: 502 });
  }

  // Set appropriate headers to pass Content-Type & Content-Length through
  const headers = new Headers();
  headers.set('Content-Type', videoRes.headers.get('Content-Type') || 'video/mp4');
  const contentLength = videoRes.headers.get('Content-Length');
  if (contentLength) {
    headers.set('Content-Length', contentLength);
  }

  // Stream video binary response
  return new Response(videoRes.body, {
    status: 200,
    headers: headers
  });
}

function corsResponse(env, response) {
  const origin = env.ALLOWED_ORIGIN || '*';
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  headers.set('Access-Control-Max-Age', '86400');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

/**
 * ดึงรูปภาพสินค้าภาพแรกจากลิงก์สินค้า Lazada หรือ Shopee
 */
async function handleScrapeProduct(request) {
  try {
    const body = await request.json();
    const productUrl = body.productUrl?.trim();
    if (!productUrl) {
      return json({ error: 'Missing productUrl' }, 400);
    }

    // เรียกดึงข้อมูลหน้าเว็บ
    const res = await fetch(productUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8'
      },
      redirect: 'follow'
    });

    if (!res.ok) {
      return json({ error: `Failed to fetch product page: ${res.status}` }, 502);
    }

    const html = await res.text();
    const finalProductUrl = res.url || productUrl;
    let imageUrl = '';
    let imageUrls = [];

    // ─── STEP A: ค้นหารายชื่อไฟล์วิดีโอปก (Video Cover) เพื่อนำมาคัดกรองออก ───
    let videoCovers = [];
    const videoKeys = [
      /["']videoPic["']\s*:\s*["']([^"']+)["']/gi,
      /["']videoCover["']\s*:\s*["']([^"']+)["']/gi,
      /["']video_cover["']\s*:\s*["']([^"']+)["']/gi,
      /["']coverUrl["']\s*:\s*["']([^"']+)["']/gi
    ];
    for (const keyReg of videoKeys) {
      let match;
      while ((match = keyReg.exec(html)) !== null) {
        let vUrl = match[1];
        if (vUrl) {
          vUrl = vUrl.replace(/\\/g, '');
          const baseNameMatch = vUrl.match(/\/([a-zA-Z0-9_-]+)\.(jpg|png|webp|jpeg)/i);
          if (baseNameMatch) {
            videoCovers.push(baseNameMatch[1]);
          }
        }
      }
    }
    // เพิ่มการจับคู่แฮชวิดีโอเพิ่มเติมในโครงสร้างข้อมูล JSON
    if (html.includes('video')) {
      const videoPicReg = /"video(?:Pic|Cover|Url)":"([^"]+)"/gi;
      let match;
      while ((match = videoPicReg.exec(html)) !== null) {
        const baseNameMatch = match[1].replace(/\\/g, '').match(/\/([a-zA-Z0-9_-]+)\.(jpg|png|webp|jpeg)/i);
        if (baseNameMatch) {
          videoCovers.push(baseNameMatch[1]);
        }
      }
    }

    // ฟังก์ชันทำความสะอาดและคัดกรองลิงก์รูปภาพ: ป้องกันไฟล์ซ้ำ และกรองรูปวิดีโอปกออก
    function cleanAndFilterImages(matches) {
      if (!matches) return [];
      const cleanUrls = matches.map(url => {
        let clean = url.replace(/&amp;/g, '&').replace(/\\u002F/g, '/').replace(/\\/g, '');
        if (clean.startsWith('//')) {
          clean = 'https:' + clean;
        }
        return clean;
      });

      return Array.from(new Set(cleanUrls)).filter(url => {
        if (!url || (!url.startsWith('http') && !url.startsWith('//'))) return false;
        
        // ตรวจสอบคีย์ของรูปภาพเพื่อทำการคัดออกถ้าเป็นภาพวิดีโอปก
        for (const cover of videoCovers) {
          if (url.includes(cover)) {
            return false;
          }
        }
        return true;
      });
    }

    // ─── STEP B: STRATEGY 1 - แกะจาก JSON-LD Product Schema (SEO Data คลีนสุด ไม่มีวิดีโอ) ───
    // Shopee exposes product preview images to social crawlers even when the app
    // shell/API path is blocked by anti-bot checks.
    imageUrls = await scrapeShopeeOpenGraphImages(finalProductUrl || productUrl);
    imageUrl = imageUrls[0] || '';
    if (!imageUrl) {
      imageUrl = await scrapeShopeeProductImage(finalProductUrl, html);
    }

    const jsonLdReg = /<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let ldMatch;
    let jsonLdImages = [];

    while ((ldMatch = jsonLdReg.exec(html)) !== null) {
      try {
        const jsonText = ldMatch[1].trim();
        const data = JSON.parse(jsonText);
        const objects = Array.isArray(data) ? data : [data];
        for (const obj of objects) {
          if (obj["@type"] === "Product" || obj["image"]) {
            const imgVal = obj["image"];
            if (Array.isArray(imgVal)) {
              jsonLdImages.push(...imgVal);
            } else if (typeof imgVal === 'string' && imgVal) {
              jsonLdImages.push(imgVal);
            }
          }
        }
      } catch (e) {}
    }

    const filteredJsonLd = cleanAndFilterImages(jsonLdImages);
    if (filteredJsonLd.length > 0) {
      imageUrl = filteredJsonLd.length > 1 ? filteredJsonLd[1] : filteredJsonLd[0];
    }

    // ─── STEP C: STRATEGY 2 - แกะจากแพลตฟอร์ม CDN (Shopee / Lazada) ───
    
    // Shopee CDN
    if (!imageUrl && (finalProductUrl.includes('shopee') || productUrl.includes('shopee') || html.includes('shopee'))) {
      const shopeeCdnReg = /(?:https?:)?(?:\\?\/\\?\/)(?:down-[a-z]{2}|cf)\.img\.susercontent\.com\\?\/file\\?\/[a-zA-Z0-9_-]+/g;
      const shopeeMatches = html.match(shopeeCdnReg);
      const filteredShopee = cleanAndFilterImages(shopeeMatches);
      if (filteredShopee.length > 0) {
        imageUrl = filteredShopee.length > 1 ? filteredShopee[1] : filteredShopee[0];
      }
    }

    // Lazada CDN
    if (!imageUrl && (finalProductUrl.includes('lazada') || productUrl.includes('lazada') || html.includes('lazada'))) {
      const slaticReg = /(\/\/sg-live-[^\s"']+\.slatic\.net\/p\/[^\s"']+)/g;
      const slaticMatches = html.match(slaticReg);
      const filteredSlatic = cleanAndFilterImages(slaticMatches);
      if (filteredSlatic.length > 0) {
        imageUrl = filteredSlatic.length > 1 ? filteredSlatic[1] : filteredSlatic[0];
      }
    }

    // ─── STEP D: STRATEGY 3 - ตรวจสอบ Open Graph และ Twitter ───
    if (!imageUrl) {
      const ogMatches = [];
      const ogImageMatch = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i) ||
                           html.match(/<meta\s+content=["']([^"']+)["']\s+property=["']og:image["']/i);
      if (ogImageMatch) ogMatches.push(ogImageMatch[1]);

      const twitterImageMatch = html.match(/<meta\s+name=["']twitter:image["']\s+content=["']([^"']+)["']/i);
      if (twitterImageMatch) ogMatches.push(twitterImageMatch[1]);

      const filteredOg = cleanAndFilterImages(ogMatches);
      if (filteredOg.length > 0) {
        imageUrl = filteredOg[0];
      }
    }

    // ทำความสะอาดและแปลง URL ขั้นสุดท้าย
    if (imageUrl) {
      imageUrl = imageUrl.replace(/&amp;/g, '&').replace(/\\u002F/g, '/').replace(/\\/g, '');
      if (imageUrl.startsWith('//')) {
        imageUrl = 'https:' + imageUrl;
      }
    }

    return json({
      success: true,
      imageUrl: imageUrl || '',
      imageUrls: imageUrls.length ? imageUrls : (imageUrl ? [imageUrl] : []),
      resolvedProductUrl: finalProductUrl || productUrl
    });

  } catch (err) {
    console.error('Product scraping error:', err);
    return json({ error: err.message || 'Internal Server Error' }, 500);
  }
}

function parseShopeeItemIds(productUrl) {
  const decodedUrl = decodeURIComponent(productUrl || '');
  const patterns = [
    /[?&]shopid=(\d+).*?[?&]itemid=(\d+)/i,
    /\/product\/(\d+)\/(\d+)/i,
    /\/[^/?#]+\/(\d+)\/(\d+)(?:[/?#]|$)/i,
    /(?:^|[.-])i\.(\d+)\.(\d+)(?:\D|$)/i
  ];

  for (const pattern of patterns) {
    const match = decodedUrl.match(pattern);
    if (match) {
      return { shopid: match[1], itemid: match[2] };
    }
  }

  return null;
}

function extractMetaContent(html, propertyName) {
  const escaped = propertyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const metaTags = html.match(/<meta\b[^>]*>/gi) || [];

  for (const tag of metaTags) {
    const hasProperty = new RegExp(`\\b(?:property|name)=["']${escaped}["']`, 'i').test(tag);
    if (!hasProperty) continue;

    const contentMatch = tag.match(/\bcontent=["']([^"']+)["']/i);
    if (contentMatch?.[1]) {
      return contentMatch[1]
        .replace(/&amp;/g, '&')
        .replace(/\\u002F/g, '/')
        .replace(/\\/g, '');
    }
  }

  return '';
}

async function scrapeShopeeOpenGraphImage(productUrl) {
  const images = await scrapeShopeeOpenGraphImages(productUrl);
  return images[0] || '';
}

async function scrapeShopeeOpenGraphImages(productUrl) {
  if (!productUrl.includes('shopee')) return [];

  try {
    const res = await fetch(productUrl, {
      headers: {
        'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8'
      },
      redirect: 'follow'
    });

    if (!res.ok) return '';
    const html = await res.text();
    const images = extractShopeeProductImagesFromHtml(html);
    if (images.length) return images.slice(0, 10);

    return [
      extractMetaContent(html, 'og:square_image'),
      extractMetaContent(html, 'og:image'),
      extractMetaContent(html, 'twitter:image')
    ].filter(Boolean).slice(0, 10);
  } catch (e) {
    console.warn('Shopee Open Graph scrape failed:', e?.message || e);
    return [];
  }
}

function extractShopeeProductImageFromHtml(html) {
  const images = extractShopeeProductImagesFromHtml(html);
  return images[0] || '';
}

function extractShopeeProductImagesFromHtml(html) {
  const imageReg = /https:\/\/down-[a-z]{2}\.img\.susercontent\.com\/file\/(th-[a-zA-Z0-9_-]+)(?:@[a-zA-Z0-9_]+)?(?:\.webp)?/g;
  const candidates = [];
  let match;

  while ((match = imageReg.exec(html)) !== null) {
    const url = `https://down-th.img.susercontent.com/file/${match[1]}`;
    if (/promo-dim|avatar|icon|logo|badge|mall|default|placeholder/i.test(url)) continue;
    candidates.push(url);
  }

  const uniqueCandidates = Array.from(new Set(candidates));
  const productCandidates = uniqueCandidates.filter(url => !/\/th-111342(?:58|16)-|\/th-11134207-81zt/i.test(url));
  return (productCandidates.length ? productCandidates : uniqueCandidates.slice(1).concat(uniqueCandidates.slice(0, 1))).slice(0, 10);
}

function getShopeeCountryCode(productUrl) {
  try {
    const host = new URL(productUrl).hostname.toLowerCase();
    if (host.endsWith('.co.th')) return 'th';
    if (host.endsWith('.com.my')) return 'my';
    if (host.endsWith('.com.br')) return 'br';
    if (host.endsWith('.com.mx')) return 'mx';
    if (host.endsWith('.com.co')) return 'co';
    if (host.endsWith('.com.ar')) return 'ar';
    if (host.endsWith('.cl')) return 'cl';
    if (host.endsWith('.tw')) return 'tw';
    if (host.endsWith('.vn')) return 'vn';
    if (host.endsWith('.ph')) return 'ph';
    if (host.endsWith('.sg')) return 'sg';
    if (host.endsWith('.co.id')) return 'id';
  } catch (e) {}
  return 'th';
}

function buildShopeeImageUrl(imageId, productUrl) {
  if (!imageId || typeof imageId !== 'string') return '';
  if (imageId.startsWith('http')) return imageId.replace(/\\/g, '');

  const cleanId = imageId
    .replace(/&amp;/g, '&')
    .replace(/\\u002F/g, '/')
    .replace(/\\/g, '')
    .replace(/^\/+file\/+/i, '')
    .trim();

  if (!/^[a-zA-Z0-9_-]+$/.test(cleanId)) return '';
  return `https://down-${getShopeeCountryCode(productUrl)}.img.susercontent.com/file/${cleanId}`;
}

function pickShopeeImageFromData(data, productUrl) {
  const item = data?.data?.item || data?.data || data?.item || data;
  const candidates = [];

  if (Array.isArray(item?.images)) candidates.push(...item.images);
  if (item?.image) candidates.push(item.image);
  if (Array.isArray(item?.tier_variations)) {
    for (const variation of item.tier_variations) {
      if (Array.isArray(variation.images)) candidates.push(...variation.images);
    }
  }
  if (Array.isArray(item?.models)) {
    for (const model of item.models) {
      if (model?.extinfo?.image) candidates.push(model.extinfo.image);
      if (model?.image) candidates.push(model.image);
    }
  }

  for (const candidate of candidates) {
    const imageUrl = buildShopeeImageUrl(candidate, productUrl);
    if (imageUrl) return imageUrl;
  }

  return '';
}

function pickShopeeImageFromHtml(html, productUrl) {
  const directMatches = html.match(/(?:https?:)?(?:\\?\/\\?\/)(?:down-[a-z]{2}|cf)\.img\.susercontent\.com\\?\/file\\?\/[a-zA-Z0-9_-]+/g);
  if (directMatches?.length) {
    const imageUrl = directMatches[0].replace(/\\\//g, '/');
    return imageUrl.startsWith('//') ? `https:${imageUrl}` : imageUrl;
  }

  const imageIdPatterns = [
    /"images"\s*:\s*\[\s*"([a-zA-Z0-9_-]+)"/,
    /"image"\s*:\s*"([a-zA-Z0-9_-]+)"/,
    /"image_id"\s*:\s*"([a-zA-Z0-9_-]+)"/
  ];

  for (const pattern of imageIdPatterns) {
    const match = html.match(pattern);
    const imageUrl = buildShopeeImageUrl(match?.[1], productUrl);
    if (imageUrl) return imageUrl;
  }

  return '';
}

async function scrapeShopeeProductImage(productUrl, html) {
  if (!productUrl.includes('shopee') && !html.includes('shopee')) return '';

  const ids = parseShopeeItemIds(productUrl);
  if (ids) {
    try {
      const apiUrl = new URL('/api/v4/item/get', productUrl);
      apiUrl.searchParams.set('shopid', ids.shopid);
      apiUrl.searchParams.set('itemid', ids.itemid);

      const apiRes = await fetch(apiUrl.toString(), {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json,text/plain,*/*',
          'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8',
          'Referer': productUrl
        }
      });

      if (apiRes.ok) {
        const data = await apiRes.json();
        const imageUrl = pickShopeeImageFromData(data, productUrl);
        if (imageUrl) return imageUrl;
      }
    } catch (e) {
      console.warn('Shopee item API scrape failed:', e?.message || e);
    }
  }

  return pickShopeeImageFromHtml(html, productUrl);
}
