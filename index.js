/**
 * Cloudflare Workers - Self-hosted Meting API
 *
 * Talks to NetEase Cloud Music weapi directly.
 * Supports 6 types: playlist / song / url / pic / lrc / search.
 * url endpoint supports format=json to return the real CDN address
 * (used by the player to download a blob for audio effects).
 *
 * 525 blocking solution:
 *   NetEase blocks Cloudflare IP ranges (fetch music.163.com fails with
 *   525 SSL handshake errors). All upstream requests go through
 *   neteaseFetch() with multi-level fallback:
 *     1. Direct connection to music.163.com (fastest when CF IP is fine)
 *     2. On failure (network error or 521/522/523/525/530) retry through
 *        proxy.646474.xyz (verified to forward weapi encrypted POSTs fully)
 *     3. After a direct failure, a 5-minute circuit breaker kicks in so
 *        subsequent requests go straight to the proxy without waiting
 *        for the direct timeout
 *
 * Deploy:
 *   A. Cloudflare Dashboard: Workers & Pages -> Create -> paste this file
 *   B. wrangler CLI: wrangler deploy
 *   C. Cloudflare API (see repo README)
 *
 * Bind custom domain meting-api.646474.xyz afterwards
 * (Workers -> Settings -> Domains & Routes). js/player.js apiUrl stays unchanged.
 */

// ============================================================
//  Upstream access (direct + proxy multi-level fallback)
// ============================================================

const PROXY_PREFIX = 'https://proxy.646474.xyz/';

// Circuit breaker: cooldown after a direct-connection failure
// (isolate-level shared, tracks upstream health, not request state)
let _directFailedUntil = 0;
const DIRECT_BLOCK_MS = 5 * 60 * 1000;

// Cloudflare edge-to-origin connection failure status codes
// (525 = SSL handshake failure, i.e. NetEase blocking the CF IP)
function isEdgeConnError(status) {
  return status === 521 || status === 522 || status === 523 || status === 525 || status === 530;
}

async function fetchWithTimeout(url, init, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Unified entry for requests to music.163.com: direct first, proxy on failure
async function neteaseFetch(url, init = {}, timeoutMs = 15000) {
  const now = Date.now();

  if (now >= _directFailedUntil) {
    try {
      const resp = await fetchWithTimeout(url, init, 6000);
      if (!isEdgeConnError(resp.status)) {
        return resp; // direct connection OK
      }
      // 52x edge error: consume body to release the connection, fall to proxy
      await resp.text().catch(() => {});
    } catch (e) {
      // fetch error (timeout/DNS/TLS): fall to proxy
    }
    // Direct unavailable: open the circuit breaker
    _directFailedUntil = now + DIRECT_BLOCK_MS;
  }

  return fetchWithTimeout(PROXY_PREFIX + url, init, timeoutMs);
}

// ============================================================
//  MD5 (RFC 1321) - pure JS, Web Crypto has no MD5
// ============================================================

function md5Raw(input) {
  function rotateLeft(x, n) { return (x << n) | (x >>> (32 - n)); }
  function addUnsigned(x, y) { return ((x & 0x7fffffff) + (y & 0x7fffffff)) ^ (x & 0x80000000) ^ (y & 0x80000000); }

  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const len = bytes.length;
  const padded = new Uint8Array((((len + 8) >>> 6) + 1) << 6);
  padded.set(bytes);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, len * 8, true);

  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;

  for (let i = 0; i < padded.length; i += 64) {
    const chunk = new Uint32Array(padded.buffer.slice(i, i + 64));
    for (let j = 0; j < 16; j++) chunk[j] = (new DataView(padded.buffer)).getUint32(i + j * 4, true);

    let aa = a, bb = b, cc = c, dd = d;

    function f(x, y, z) { return (x & y) | (~x & z); }
    function g(x, y, z) { return (x & z) | (y & ~z); }
    function h(x, y, z) { return x ^ y ^ z; }
    function i(x, y, z) { return y ^ (x | ~z); }

    const S11 = 7, S12 = 12, S13 = 17, S14 = 22;
    const S21 = 5, S22 = 9, S23 = 14, S24 = 20;
    const S31 = 4, S32 = 11, S33 = 16, S34 = 23;
    const S41 = 6, S42 = 10, S43 = 15, S44 = 21;

    const T = [];
    for (let j = 1; j <= 64; j++) T[j] = Math.floor((1 << 30) * Math.abs(Math.sin(j)));

    function op(aa_val, bb_val, cc_val, dd_val, k, s, i_idx) {
      return addUnsigned(rotateLeft(addUnsigned(addUnsigned(aa_val, f(bb_val, cc_val, dd_val)), addUnsigned(chunk[k], T[i_idx])), s), bb_val);
    }
    a = op(a, b, c, d, 0, S11, 1);  d = op(d, a, b, c, 1, S12, 2);
    c = op(c, d, a, b, 2, S13, 3);  b = op(b, c, d, a, 3, S14, 4);
    a = op(a, b, c, d, 4, S11, 5);  d = op(d, a, b, c, 5, S12, 6);
    c = op(c, d, a, b, 6, S13, 7);  b = op(b, c, d, a, 7, S14, 8);
    a = op(a, b, c, d, 8, S11, 9);  d = op(d, a, b, c, 9, S12, 10);
    c = op(c, d, a, b, 10, S13, 11); b = op(b, c, d, a, 11, S14, 12);
    a = op(a, b, c, d, 12, S11, 13); d = op(d, a, b, c, 13, S12, 14);
    c = op(c, d, a, b, 14, S13, 15); b = op(b, c, d, a, 15, S14, 16);

    function opG(aa_val, bb_val, cc_val, dd_val, k, s, i_idx) {
      return addUnsigned(rotateLeft(addUnsigned(addUnsigned(aa_val, g(bb_val, cc_val, dd_val)), addUnsigned(chunk[k], T[i_idx])), s), bb_val);
    }
    a = opG(a, b, c, d, 1, S21, 17);  d = opG(d, a, b, c, 6, S22, 18);
    c = opG(c, d, a, b, 11, S23, 19); b = opG(b, c, d, a, 0, S24, 20);
    a = opG(a, b, c, d, 5, S21, 21);  d = opG(d, a, b, c, 10, S22, 22);
    c = opG(c, d, a, b, 15, S23, 23); b = opG(b, c, d, a, 4, S24, 24);
    a = opG(a, b, c, d, 9, S21, 25);  d = opG(d, a, b, c, 14, S22, 26);
    c = opG(c, d, a, b, 3, S23, 27);  b = opG(b, c, d, a, 8, S24, 28);
    a = opG(a, b, c, d, 13, S21, 29); d = opG(d, a, b, c, 2, S22, 30);
    c = opG(c, d, a, b, 7, S23, 31);  b = opG(b, c, d, a, 12, S24, 32);

    function opH(aa_val, bb_val, cc_val, dd_val, k, s, i_idx) {
      return addUnsigned(rotateLeft(addUnsigned(addUnsigned(aa_val, h(bb_val, cc_val, dd_val)), addUnsigned(chunk[k], T[i_idx])), s), bb_val);
    }
    a = opH(a, b, c, d, 5, S31, 33);  d = opH(d, a, b, c, 8, S32, 34);
    c = opH(c, d, a, b, 11, S33, 35); b = opH(b, c, d, a, 14, S34, 36);
    a = opH(a, b, c, d, 1, S31, 37);  d = opH(d, a, b, c, 4, S32, 38);
    c = opH(c, d, a, b, 7, S33, 39);  b = opH(b, c, d, a, 10, S34, 40);
    a = opH(a, b, c, d, 13, S31, 41); d = opH(d, a, b, c, 0, S32, 42);
    c = opH(c, d, a, b, 3, S33, 43);  b = opH(b, c, d, a, 6, S34, 44);
    a = opH(a, b, c, d, 9, S31, 45);  d = opH(d, a, b, c, 12, S32, 46);
    c = opH(c, d, a, b, 15, S33, 47); b = opH(b, c, d, a, 2, S34, 48);

    function opI(aa_val, bb_val, cc_val, dd_val, k, s, i_idx) {
      return addUnsigned(rotateLeft(addUnsigned(addUnsigned(aa_val, i(bb_val, cc_val, dd_val)), addUnsigned(chunk[k], T[i_idx])), s), bb_val);
    }
    a = opI(a, b, c, d, 0, S41, 49);  d = opI(d, a, b, c, 7, S42, 50);
    c = opI(c, d, a, b, 14, S43, 51); b = opI(b, c, d, a, 5, S44, 52);
    a = opI(a, b, c, d, 12, S41, 53); d = opI(d, a, b, c, 3, S42, 54);
    c = opI(c, d, a, b, 10, S43, 55); b = opI(b, c, d, a, 1, S44, 56);
    a = opI(a, b, c, d, 8, S41, 57);  d = opI(d, a, b, c, 15, S42, 58);
    c = opI(c, d, a, b, 6, S43, 59);  b = opI(b, c, d, a, 13, S44, 60);
    a = opI(a, b, c, d, 4, S41, 61);  d = opI(d, a, b, c, 11, S42, 62);
    c = opI(c, d, a, b, 2, S43, 63);  b = opI(b, c, d, a, 9, S44, 64);

    a = addUnsigned(a, aa); b = addUnsigned(b, bb);
    c = addUnsigned(c, cc); d = addUnsigned(d, dd);
  }

  const result = new Uint8Array(16);
  const dv = new DataView(result.buffer);
  dv.setUint32(0, a, true);
  dv.setUint32(4, b, true);
  dv.setUint32(8, c, true);
  dv.setUint32(12, d, true);
  return result;
}

// ============================================================
//  Crypto helpers
// ============================================================

function randomHex(length) {
  const bytes = new Uint8Array(length / 2);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64(bytes) {
  let binary = '';
  bytes.forEach(b => binary += String.fromCharCode(b));
  return btoa(binary);
}

async function aesEncrypt(plaintext, keyStr, ivStr) {
  const encoder = new TextEncoder();
  const data = encoder.encode(plaintext);
  const key = encoder.encode(keyStr);
  const iv = encoder.encode(ivStr);

  const cryptoKey = await crypto.subtle.importKey(
    'raw', key, { name: 'AES-CBC' }, false, ['encrypt']
  );
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-CBC', iv }, cryptoKey, data
  );
  return bytesToBase64(new Uint8Array(encrypted));
}

function modPow(base, exp, mod) {
  let result = 1n;
  base = base % mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

function rsaEncrypt(text) {
  const modulus = BigInt(
    '0x00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725' +
    '152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ec' +
    'bda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813' +
    'cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7'
  );
  const pubkey = 0x010001n;

  const reversed = text.split('').reverse().join('');
  const hex = Array.from(new TextEncoder().encode(reversed))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  const m = BigInt('0x' + hex);
  const result = modPow(m, pubkey, modulus);
  return result.toString(16).padStart(256, '0');
}

// ============================================================
//  NetEase weapi encryption
// ============================================================

const NONCE = '0CoJUm6Qyw8W8jud';
const IV = '0102030405060708';
const FALLBACK_ENCSECKEY =
  '85302b818aea19b68db899c25dac229412d9bba9b3fcfe4f714dc016bc1686fc' +
  '446a08844b1f8327fd9cb623cc189be00c5a365ac835e93d4858ee66f43fdc59' +
  'e32aaed3ef24f0675d70172ef688d376a4807228c55583fe5bac647d10ecef15' +
  '220feef61477c28cae8406f6f9896ed329d6db9f88757e31848a6c2ce2f94308';

async function weapiEncrypt(object) {
  const body = JSON.stringify(object);

  let skey;
  try { skey = randomHex(16); } catch (_) { skey = 'B3v3kH4vRPWRJFfH'; }

  const firstPass = await aesEncrypt(body, NONCE, IV);
  const params = await aesEncrypt(firstPass, skey, IV);

  let encSecKey;
  try {
    encSecKey = rsaEncrypt(skey);
  } catch (_) {
    encSecKey = FALLBACK_ENCSECKEY;
  }

  return { params, encSecKey };
}

// ============================================================
//  NetEase API requests
// ============================================================

function randomChinaIP() {
  const base = (112 << 24) | (90 << 16);
  const range = (1 << 16) | (35 << 8) | 255;
  const ip = base + Math.floor(Math.random() * range);
  return `${(ip >> 24) & 0xff}.${(ip >> 16) & 0xff}.${(ip >> 8) & 0xff}.${ip & 0xff}`;
}

function buildHeaders() {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    'Referer': 'https://music.163.com/',
    'Content-Type': 'application/x-www-form-urlencoded',
    'Cookie': 'appver=8.2.30; os=iPhone OS; osver=15.0; EVNSM=1.0.0; buildver=2206; channel=distribution; machineid=iPhone13.3',
    'X-Real-IP': randomChinaIP(),
  };
}

async function weapiRequest(path, body) {
  const encrypted = await weapiEncrypt(body);
  const formBody = `params=${encodeURIComponent(encrypted.params)}&encSecKey=${encodeURIComponent(encrypted.encSecKey)}`;

  const resp = await neteaseFetch(`https://music.163.com${path}`, {
    method: 'POST',
    headers: buildHeaders(),
    body: formBody,
  });

  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    // NetEase risk-control may return an HTML error page; surface a diagnosable error
    throw new Error(`netease returned non-JSON (HTTP ${resp.status}): ${text.slice(0, 120)}`);
  }
}

// ============================================================
//  netease_encryptId - used to build direct image URLs
// ============================================================

function neteaseEncryptId(id) {
  const magic = '3go8&$8*3*3h0k(2)2';
  const bytes = new Uint8Array(id.length);
  for (let i = 0; i < id.length; i++) {
    bytes[i] = id.charCodeAt(i) ^ magic.charCodeAt(i % magic.length);
  }
  const hash = md5Raw(bytes);
  const b64 = bytesToBase64(hash);
  return b64.replace(/\//g, '_').replace(/\+/g, '-');
}

function extractPicId(picUrl) {
  if (!picUrl) return '';
  const match = picUrl.match(/\/(\d+)\.(jpg|png|webp)/);
  return match ? match[1] : '';
}

// ============================================================
//  API handlers
// ============================================================

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

async function handlePlaylist(id, workerOrigin) {
  const playlistData = await weapiRequest('/weapi/v3/playlist/detail', {
    id: id,
    n: 100000,
    s: 0,
  });

  if (!playlistData.playlist || !playlistData.playlist.trackIds) {
    return [];
  }

  const trackIds = playlistData.playlist.trackIds;
  if (!trackIds.length) return [];

  const allTracks = [];
  const BATCH = 500;

  for (let i = 0; i < trackIds.length; i += BATCH) {
    const batch = trackIds.slice(i, i + BATCH);
    const c = JSON.stringify(batch.map(t => ({ id: t.id, v: 0 })));
    const songData = await weapiRequest('/weapi/v3/song/detail', { c });
    if (songData.songs) {
      allTracks.push(...songData.songs);
    }
  }

  return allTracks.map(track => {
    const picUrl = (track.al && track.al.picUrl) ? track.al.picUrl : '';
    const picId = extractPicId(picUrl) || track.id;
    const picSrc = picUrl ? `&src=${encodeURIComponent(picUrl)}` : '';
    return {
      name: track.name,
      artist: (track.ar || []).map(a => a.name).join('/'),
      url: `${workerOrigin}?server=netease&type=url&id=${track.id}`,
      pic: `${workerOrigin}?server=netease&type=pic&id=${picId}${picSrc}`,
      lrc: `${workerOrigin}?server=netease&type=lrc&id=${track.id}`,
    };
  });
}

async function handleSong(id, workerOrigin) {
  const data = await weapiRequest('/weapi/v3/song/detail', {
    c: JSON.stringify([{ id: id, v: 0 }]),
  });

  if (!data.songs || !data.songs[0]) {
    return [];
  }

  const song = data.songs[0];
  const picUrl = (song.al && song.al.picUrl) ? song.al.picUrl : '';
  const picId = extractPicId(picUrl) || song.id;
  const picSrc = picUrl ? `&src=${encodeURIComponent(picUrl)}` : '';

  return [{
    name: song.name,
    artist: (song.ar || []).map(a => a.name).join('/'),
    url: `${workerOrigin}?server=netease&type=url&id=${song.id}`,
    pic: `${workerOrigin}?server=netease&type=pic&id=${picId}${picSrc}`,
    lrc: `${workerOrigin}?server=netease&type=lrc&id=${song.id}`,
  }];
}

async function handleUrl(id, format) {
  // format=json: call weapi to get the real CDN address
  // (used by the player in audio-effect mode to download a blob)
  if (format === 'json') {
    try {
      const data = await weapiRequest('/weapi/song/enhance/player/url/v1', {
        ids: JSON.stringify([parseInt(id) || id]),
        level: 'standard',
        encodeType: 'mp3',
        csrf_token: '',
      });
      const d = data && data.data && data.data[0];
      if (d && d.url) {
        return { ok: true, url: d.url, size: d.size, type: d.type };
      }
      // weapi returned nothing (no license / VIP / risk control): fall back to the public link
      return { ok: false, error: 'no url from weapi', url: `https://music.163.com/song/media/outer/url?id=${id}.mp3` };
    } catch (e) {
      return { ok: false, error: e.message || 'weapi error', url: `https://music.163.com/song/media/outer/url?id=${id}.mp3` };
    }
  }
  // Default: 302 redirect to the public link so the browser's own IP follows NetEase's redirect (most stable)
  const publicUrl = `https://music.163.com/song/media/outer/url?id=${id}.mp3`;
  return { ok: true, url: publicUrl };
}

async function handlePic(id, src) {
  // Prefer the real picUrl passed via the src parameter (provided by playlist/song endpoints)
  if (src) {
    let url = decodeURIComponent(src);
    url = url.replace(/param=\d+y\d+/, 'param=800y800');
    if (!url.includes('param=')) {
      url += (url.includes('?') ? '&' : '?') + 'param=800y800';
    }
    return url;
  }

  const encryptedId = neteaseEncryptId(id);
  return `https://p3.music.126.net/${encryptedId}/${id}.jpg?param=800y800`;
}

async function handleLrc(id) {
  const data = await weapiRequest('/weapi/song/lyric', {
    id: id,
    os: 'linux',
    lv: -1,
    kv: -1,
    tv: -1,
  });
  return data.lrc ? (data.lrc.lyric || '') : '';
}

// NetEase search (multi-level fallback for robustness)
// Plan 1: weapi/cloudsearch (new encrypted search)
// Plan 2: legacy GET search endpoint (no encryption needed, as fallback)
async function handleSearch(keyword, workerOrigin, limit = 30) {
  const mapSong = (song, isWeapi) => {
    const ar = isWeapi ? (song.ar || []) : (song.artists || []);
    const al = isWeapi ? song.al : song.album;
    const picUrl = (al && al.picUrl) ? al.picUrl : (al && al.picId ? `https://p1.music.126.net/${al.picId}/${al.picId}.jpg` : '');
    const picId = extractPicId(picUrl) || song.id;
    const picSrc = picUrl ? `&src=${encodeURIComponent(picUrl)}` : '';
    return {
      id: song.id,
      name: song.name,
      artist: ar.map(a => a.name).join('/'),
      album: (al && al.name) ? al.name : '',
      pic_id: picId,
      lyric_id: song.id,
      pic: `${workerOrigin}?server=netease&type=pic&id=${picId}${picSrc}`,
      url: `${workerOrigin}?server=netease&type=url&id=${song.id}`,
      lrc: `${workerOrigin}?server=netease&type=lrc&id=${song.id}`,
      source: 'netease',
    };
  };

  // Plan 1: weapi/cloudsearch
  try {
    const data = await weapiRequest('/weapi/cloudsearch/get/web', {
      s: keyword, type: 1, limit, offset: 0,
    });
    if (data && data.result && data.result.songs && data.result.songs.length > 0) {
      return data.result.songs.map(s => mapSong(s, true));
    }
  } catch (e) { /* fall through */ }

  // Plan 2: legacy search endpoint (GET, no weapi encryption)
  try {
    const searchUrl = `https://music.163.com/api/search/get?s=${encodeURIComponent(keyword)}&type=1&offset=0&limit=${limit}`;
    const resp = await neteaseFetch(searchUrl, { headers: buildHeaders() });
    const data = await resp.json();
    if (data && data.result && data.result.songs && data.result.songs.length > 0) {
      return data.result.songs.map(s => mapSong(s, false));
    }
  } catch (e) { /* fall through */ }

  return [];
}

// ============================================================
//  User & auth API (D1-backed)
//    POST /auth/register     {username, password} -> {token}
//    POST /auth/login        {username, password} -> {token}
//    POST /auth/logout       (Bearer) -> 204
//    GET  /user/playcounts   (Bearer) -> {counts}
//    PUT  /user/playcounts   (Bearer) {counts} -> full replace
// ============================================================

const USER_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const SESSION_TTL = 90 * 24 * 3600; // 90 days
const MAX_COUNT_ROWS = 3000;        // per user, guard against abuse

function userJson(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...USER_CORS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function toHex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

// PBKDF2-SHA256, returns "saltHex:hashHex" (100k iterations, 256-bit)
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256
  );
  return toHex(salt) + ':' + toHex(new Uint8Array(bits));
}

async function verifyPassword(password, stored) {
  const parts = stored.split(':');
  if (parts.length !== 2) return false;
  const [saltHex, hashHex] = parts;
  const salt = new Uint8Array(saltHex.match(/.{2}/g).map(h => parseInt(h, 16)));
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256
  );
  const got = toHex(new Uint8Array(bits));
  if (got.length !== hashHex.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ hashHex.charCodeAt(i);
  return diff === 0;
}

function newToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

function clientIp(request) {
  return (request.headers.get('CF-Connecting-IP') || '0.0.0.0').slice(0, 45);
}

// Login throttle: 10 failures per 10-minute window per IP
async function throttleCheck(db, ip) {
  const now = Math.floor(Date.now() / 1000);
  const row = await db.prepare('SELECT fails, window_start FROM login_throttle WHERE ip = ?').bind(ip).first();
  if (!row) return true;
  if (now - row.window_start > 600) {
    await db.prepare('DELETE FROM login_throttle WHERE ip = ?').bind(ip).run();
    return true;
  }
  return row.fails < 10;
}

async function throttleFail(db, ip) {
  const now = Math.floor(Date.now() / 1000);
  await db.prepare(`
    INSERT INTO login_throttle (ip, fails, window_start) VALUES (?, 1, ?)
    ON CONFLICT(ip) DO UPDATE SET fails = fails + 1
  `).bind(ip, now).run();
}

async function throttleClear(db, ip) {
  await db.prepare('DELETE FROM login_throttle WHERE ip = ?').bind(ip).run();
}

// Resolve Bearer token -> {userId, username}, or null
async function getSessionUser(db, request) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const row = await db.prepare(`
    SELECT s.token, s.expires_at, u.id AS uid, u.username
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?
  `).bind(token).first();
  if (!row) return null;
  if (Math.floor(Date.now() / 1000) > row.expires_at) {
    await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
    return null;
  }
  return { userId: row.uid, username: row.username, token };
}

function validateCredentials(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string') return 'invalid payload';
  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,24}$/.test(username)) {
    return 'username must be 2-24 chars (letters, digits, _, CJK)';
  }
  if (password.length < 6 || password.length > 128) {
    return 'password must be 6-128 chars';
  }
  return null;
}

// Validate the {counts} payload: {songKey: integer}
function sanitizeCounts(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out = [];
  for (const key of Object.keys(input)) {
    if (!/^[a-zA-Z0-9_:|.\-\/%]{1,300}$/.test(key)) return null;
    const v = input[key];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 999999) return null;
    out.push([key, v]);
  }
  if (out.length > MAX_COUNT_ROWS) return null;
  return out;
}

async function handleUserApi(request, env) {
  const db = env.DB;
  if (!db) {
    return userJson({ error: 'D1 binding missing' }, 500);
  }

  const url = new URL(request.url);
  const path = url.pathname;
  const ip = clientIp(request);

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: USER_CORS });
  }

  try {
    // ---- POST /auth/register ----
    if (path === '/auth/register' && request.method === 'POST') {
      const body = await request.json().catch(() => null);
      const username = body && body.username;
      const password = body && body.password;
      const err = validateCredentials(username, password);
      if (err) return userJson({ error: err }, 400);

      const exists = await db.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
      if (exists) return userJson({ error: 'username already taken' }, 409);

      const hash = await hashPassword(password);
      const inserted = await db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').bind(username, hash).run();
      const userId = inserted.meta && inserted.meta.last_row_id;

      const token = newToken();
      const exp = Math.floor(Date.now() / 1000) + SESSION_TTL;
      await db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').bind(token, userId, exp).run();
      return userJson({ token, username, expires_at: exp }, 201);
    }

    // ---- POST /auth/login ----
    if (path === '/auth/login' && request.method === 'POST') {
      if (!(await throttleCheck(db, ip))) {
        return userJson({ error: 'too many attempts, retry in 10 minutes' }, 429);
      }
      const body = await request.json().catch(() => null);
      const username = body && body.username;
      const password = body && body.password;
      const err = validateCredentials(username, password);
      if (err) return userJson({ error: err }, 400);

      const row = await db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').bind(username).first();
      if (!row || !(await verifyPassword(password, row.password_hash))) {
        await throttleFail(db, ip);
        return userJson({ error: 'wrong username or password' }, 401);
      }

      await throttleClear(db, ip);
      const token = newToken();
      const exp = Math.floor(Date.now() / 1000) + SESSION_TTL;
      await db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').bind(token, row.id, exp).run();
      return userJson({ token, username: row.username, expires_at: exp });
    }

    // ---- POST /auth/logout ----
    if (path === '/auth/logout' && request.method === 'POST') {
      const session = await getSessionUser(db, request);
      if (session) {
        await db.prepare('DELETE FROM sessions WHERE token = ?').bind(session.token).run();
      }
      return new Response(null, { status: 204, headers: USER_CORS });
    }

    // ---- GET /user/playcounts ----
    if (path === '/user/playcounts' && request.method === 'GET') {
      const session = await getSessionUser(db, request);
      if (!session) return userJson({ error: 'unauthorized' }, 401);
      const result = await db.prepare('SELECT song_key, count FROM play_counts WHERE user_id = ?').bind(session.userId).all();
      const counts = {};
      for (const r of result.results || []) counts[r.song_key] = r.count;
      return userJson({ counts, username: session.username });
    }

    // ---- PUT /user/playcounts ----
    if (path === '/user/playcounts' && request.method === 'PUT') {
      const session = await getSessionUser(db, request);
      if (!session) return userJson({ error: 'unauthorized' }, 401);
      const body = await request.json().catch(() => null);
      const entries = sanitizeCounts(body && body.counts);
      if (!entries) return userJson({ error: 'invalid counts payload' }, 400);

      // Full replace (idempotent; client is the source of truth)
      const stmts = [
        db.prepare('DELETE FROM play_counts WHERE user_id = ?').bind(session.userId),
      ];
      for (const [key, count] of entries) {
        stmts.push(db.prepare('INSERT INTO play_counts (user_id, song_key, count) VALUES (?, ?, ?)').bind(session.userId, key, count));
      }
      await db.batch(stmts);
      return userJson({ ok: true, saved: entries.length });
    }

    return userJson({ error: 'not found' }, 404);
  } catch (e) {
    return userJson({ error: e.message || 'internal error' }, 500);
  }
}

// ============================================================
//  Worker entry (ES Module format)
// ============================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { searchParams } = url;

    // User/account API (path-based routing, backed by D1 binding "DB")
    // Routed before the legacy query-string API; paths never collide
    // because the legacy API only reacts to ?type= parameters.
    const path = url.pathname;
    if (path === '/auth/register' || path === '/auth/login' ||
        path === '/auth/logout' || path === '/user/playcounts') {
      return handleUserApi(request, env);
    }

    // OPTIONS preflight (legacy meting API)
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const server = searchParams.get('server') || 'netease';
    const type = searchParams.get('type') || 'playlist';
    const id = searchParams.get('id');

    // search uses the keyword parameter and needs no id; others require id
    if (!id && type !== 'search') {
      return new Response(
        JSON.stringify({ error: 'missing id parameter' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } }
      );
    }

    if (server !== 'netease') {
      return new Response(
        JSON.stringify({ error: `server "${server}" not yet supported` }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } }
      );
    }

    try {
      switch (type) {
        case 'playlist': {
          const result = await handlePlaylist(id, url.origin);
          return new Response(JSON.stringify(result), {
            headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
          });
        }

        case 'song': {
          const result = await handleSong(id, url.origin);
          return new Response(JSON.stringify(result), {
            headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
          });
        }

        case 'url': {
          const format = searchParams.get('format');
          const result = await handleUrl(id, format);
          // format=json mode: return JSON (with the real CDN URL for the player's blob download)
          if (format === 'json') {
            return new Response(JSON.stringify(result), {
              headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
            });
          }
          // Default mode: 302 redirect
          if (result && result.ok) {
            return Response.redirect(result.url, 302);
          }
          return new Response(JSON.stringify(result || { error: 'url not found' }), {
            status: 404,
            headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
          });
        }

        case 'pic': {
          const src = searchParams.get('src');
          const picUrl = await handlePic(id, src);
          if (picUrl) {
            return Response.redirect(picUrl, 302);
          }
          return new Response(JSON.stringify({ error: 'pic not found' }), {
            status: 404,
            headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
          });
        }

        case 'lrc': {
          const lrc = await handleLrc(id);
          // \u6682\u65e0\u6b4c\u8bcd = "no lyrics yet" (unicode-escaped to keep source pure ASCII)
          return new Response(lrc || '[00:00.00]\u6682\u65e0\u6b4c\u8bcd', {
            headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' },
          });
        }

        case 'search': {
          const keyword = searchParams.get('keyword') || searchParams.get('name') || id;
          const result = await handleSearch(keyword, url.origin);
          return new Response(JSON.stringify(result), {
            headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
          });
        }

        default:
          return new Response(
            JSON.stringify({ error: `unknown type "${type}"` }),
            { status: 400, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } }
          );
      }
    } catch (err) {
      return new Response(
        JSON.stringify({ error: err.message || 'internal error' }),
        { status: 500, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } }
      );
    }
  },
};
