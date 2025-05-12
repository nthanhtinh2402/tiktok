import express from 'express';
import axios from 'axios';
import { exec } from 'child_process';
import { readFileSync, existsSync, writeFileSync, readFile, unlink, readdir, stat, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';

// Load biến môi trường từ file .env
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const port = process.env.PORT || 5000;

// Cấu hình
const TIKTOK_USER_AGENT = process.env.TIKTOK_USER_AGENT;
const COOKIES_PATH = join(__dirname, process.env.COOKIES_PATH);
const API_PATH_URL = process.env.API_PATH_URL || '/video';
const STREAM_PATH_URL = process.env.STREAM_PATH_URL || '/stream';
const CACHE_DIR = join(__dirname, process.env.CACHE_DIR || 'cache');
const CACHE_EXPIRY_MINUTES = parseInt(process.env.CACHE_EXPIRY_MINUTES) || 5;
const MAX_CONCURRENT_REQUESTS = parseInt(process.env.MAX_CONCURRENT_REQUESTS) || 100;
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX) || 50;
const RATE_LIMIT_WINDOW_MINUTES = parseInt(process.env.RATE_LIMIT_WINDOW_MINUTES) || 15;

// Tạo thư mục cache nếu chưa tồn tại
if (!existsSync(CACHE_DIR)) {
  mkdirSync(CACHE_DIR);
  console.log('[CONFIG] Created cache directory:', CACHE_DIR);
}

// Phục vụ file tĩnh (index.html)
app.use(express.static(__dirname));

// Kiểm tra file cookies tồn tại
if (!existsSync(COOKIES_PATH)) {
  console.error('[CONFIG] Cookies file not found:', COOKIES_PATH);
  process.exit(1);
}

// Bộ đếm yêu cầu đồng thời
let concurrentRequests = 0;

// Middleware giới hạn yêu cầu đồng thời
const concurrentLimitMiddleware = (req, res, next) => {
  if (concurrentRequests >= MAX_CONCURRENT_REQUESTS) {
    console.log('[CONCURRENT] Too many concurrent requests:', concurrentRequests);
    return res.status(429).json({ error: 'TOO_MANY_CONCURRENT_REQUESTS', details: `Maximum ${MAX_CONCURRENT_REQUESTS} concurrent requests reached` });
  }
  concurrentRequests++;
  console.log('[CONCURRENT] Current concurrent requests:', concurrentRequests);

  // Giảm bộ đếm khi yêu cầu hoàn tất hoặc gặp lỗi
  res.on('finish', () => {
    concurrentRequests--;
    console.log('[CONCURRENT] Request finished, current concurrent requests:', concurrentRequests);
  });
  res.on('error', () => {
    concurrentRequests--;
    console.log('[CONCURRENT] Request errored, current concurrent requests:', concurrentRequests);
  });

  next();
};

// Middleware giới hạn tốc độ theo IP
const rateLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MINUTES * 60 * 1000, // Thời gian cửa sổ (phút)
  max: RATE_LIMIT_MAX, // Số yêu cầu tối đa mỗi IP
  message: {
    error: 'RATE_LIMIT_EXCEEDED',
    details: `Too many requests from this IP, please try again after ${RATE_LIMIT_WINDOW_MINUTES} minutes`,
  },
  standardHeaders: true, // Trả về header RateLimit
  legacyHeaders: false,
});

// Áp dụng rate limiter cho route /stream/:id
app.use(STREAM_PATH_URL + '/:id', rateLimiter);

// Hàm parse cookie từ file Netscape format
const parseCookies = (filePath) => {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter((line) => line.trim() && !line.startsWith('#'));
    const cookies = [];

    for (const line of lines) {
      const parts = line.split('\t');
      if (parts.length >= 6) {
        const name = parts[5];
        const value = parts[6];
        if (name && value) {
          cookies.push(`${name}=${value.trim()}`);
        }
      }
    }

    const cookieString = cookies.join('; ');
    if (!cookieString) {
      throw new Error('No valid cookies found in file');
    }
    return cookieString;
  } catch (error) {
    console.error('[CONFIG] Failed to parse cookies:', error.message);
    throw error;
  }
};

// Hàm retry
const retry = async (fn, retries = process.env.RETRY_ATTEMPTS || 2, delay = process.env.RETRY_DELAY || 1000) => {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === retries - 1) throw error;
      console.log(`[Retry] Attempt ${i + 1} failed, retrying after ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
};

// Hàm lấy thông tin và stream URL bằng yt-dlp
const fetchWithYTDLP = async (videoUrl) => {
  return new Promise((resolve, reject) => {
    const command = [
      process.env.YTDLP_COMMAND,
      '--dump-json',
      `"${videoUrl}"`,
      '--no-warnings',
      `--user-agent "${TIKTOK_USER_AGENT}"`,
      '--referer "https://www.tiktok.com/"',
      `--cookies "${COOKIES_PATH}"`,
    ].join(' ');

    console.log('[YT-DLP] Executing command:', command);
    exec(command, { shell: true }, (error, stdout, stderr) => {
      console.log('[YT-DLP] stdout:', stdout);
      console.log('[YT-DLP] stderr:', stderr);

      if (error || stderr) {
        console.error('[YT-DLP] Error:', error?.message || stderr);
        reject(new Error(`YT-DLP_FAILED: ${error?.message || stderr}`));
        return;
      }

      try {
        const data = JSON.parse(stdout.trim());
        const streamUrl = data.url || data.formats?.find(f => f.mime_type?.includes('video/mp4'))?.url;
        if (!streamUrl?.startsWith('http')) {
          console.error('[YT-DLP] Invalid stream URL:', { stdout, stderr });
          reject(new Error('INVALID_STREAM_URL'));
          return;
        }

        resolve({
          streamUrl,
          thumbnail: data.thumbnail || '',
          id: data.id || '',
          title: data.title || 'Untitled Video',
        });
      } catch (parseError) {
        console.error('[YT-DLP] JSON parse error:', parseError.message);
        reject(new Error('INVALID_JSON_OUTPUT'));
      }
    });
  });
};

// Hàm proxy trực tiếp
const fetchWithProxy = async (videoUrl) => {
  try {
    const cookieContent = parseCookies(COOKIES_PATH);
    console.log('[PROXY] Cookie content:', cookieContent);

    const response = await axios.get(videoUrl, {
      responseType: 'stream',
      headers: {
        'User-Agent': TIKTOK_USER_AGENT,
        'Referer': 'https://www.tiktok.com/',
        'Origin': 'https://www.tiktok.com',
        'Cookie': cookieContent,
        'Accept': 'video/mp4',
      },
      timeout: 5000,
    });
    return { stream: response.data, id: '', title: 'Untitled Video', thumbnail: '' };
  } catch (error) {
    console.error('[PROXY] Error:', error.message);
    throw new Error(`PROXY_FAILED: ${error.message}`);
  }
};

// Hàm mã hóa và giải mã Base64
const encodeBase64 = (str) => Buffer.from(str).toString('base64');
const decodeBase64 = (str) => Buffer.from(str, 'base64').toString('utf-8');

// Hàm lưu cache vào file
const saveCache = (cacheId, data) => {
  const filePath = join(CACHE_DIR, `${cacheId}.json`);
  const cacheData = {
    ...data,
    timestamp: Date.now(),
  };
  try {
    writeFileSync(filePath, JSON.stringify(cacheData));
    console.log('[CACHE] Saved cache:', filePath);
  } catch (error) {
    console.error('[CACHE] Failed to save cache:', error.message);
  }
};

// Hàm đọc cache từ file
const getCache = (cacheId, callback) => {
  const filePath = join(CACHE_DIR, `${cacheId}.json`);
  readFile(filePath, 'utf-8', (err, data) => {
    if (err) {
      console.error('[CACHE] Cache not found:', filePath);
      callback(null);
      return;
    }
    try {
      const parsed = JSON.parse(data);
      callback(parsed);
    } catch (error) {
      console.error('[CACHE] Failed to parse cache:', error.message);
      callback(null);
    }
  });
};

// Hàm xóa file cache
const deleteCache = (cacheId) => {
  const filePath = join(CACHE_DIR, `${cacheId}.json`);
  if (existsSync(filePath)) {
    unlink(filePath, (err) => {
      if (err) {
        console.error('[CACHE] Failed to delete cache:', filePath, err.message);
      } else {
        console.log('[CACHE] Deleted cache:', filePath);
      }
    });
  }
};

// Hàm dọn dẹp cache hết hạn
const cleanupCache = () => {
  readdir(CACHE_DIR, (err, files) => {
    if (err) {
      console.error('[CACHE] Failed to read_bitmap: cache directory:', err.message);
      return;
    }

    const expiryMs = CACHE_EXPIRY_MINUTES * 60 * 1000;
    const now = Date.now();

    files.forEach((file) => {
      const filePath = join(CACHE_DIR, file);
      stat(filePath, (err, stats) => {
        if (err) {
          console.error('[CACHE] Failed to stat file:', filePath, err.message);
          return;
        }

        readFile(filePath, 'utf-8', (err, data) => {
          if (err) {
            console.error('[CACHE] Failed to read cache file:', filePath, err.message);
            return;
          }

          try {
            const cacheData = JSON.parse(data);
            if (now - cacheData.timestamp > expiryMs) {
              deleteCache(file.replace('.json', ''));
            }
          } catch (error) {
            console.error('[CACHE] Failed to parse cache file:', filePath, error.message);
          }
        });
      });
    });
  });
};

// Chạy cleanup mỗi 5 phút
setInterval(cleanupCache, 5 * 60 * 1000);

// Route trả về thông tin video
app.get(API_PATH_URL, async (req, res) => {
  const videoUrl = req.query.url;

  // Kiểm tra URL hợp lệ
  if (!videoUrl || !videoUrl.match(/tiktok\.com\/.*\/video\/\d+/)) {
    return res.status(400).json({ error: 'URL_TIKTOK_INVALID' });
  }

  try {
    // Thử yt-dlp với retry
    console.log('[Main] Attempting yt-dlp method...');
    const { streamUrl, thumbnail, id, title } = await retry(() => fetchWithYTDLP(videoUrl));
    console.log('[Success] Fetched via yt-dlp:', { streamUrl, id, title });

    // Tạo mã định danh duy nhất
    const cacheId = uuidv4();
    saveCache(cacheId, { videoUrl, streamUrl });

    // Mã hóa cacheId
    const encodedCacheId = encodeBase64(cacheId);

    // Tạo link download đầy đủ với cacheId đã mã hóa và streamPath từ .env
    const linkDownload = `${req.protocol}://${req.headers.host}${STREAM_PATH_URL}/${encodedCacheId}`;

    return res.json({ id, title, thumbnail, cacheId, linkDownload });
  } catch (ytDlpError) {
    console.log('[Fallback] Switching to proxy method...');
    try {
      const { stream, id, title, thumbnail } = await fetchWithProxy(videoUrl);
      const cacheId = uuidv4();
      saveCache(cacheId, { videoUrl, streamUrl: null });

      // Mã hóa cacheId
      const encodedCacheId = encodeBase64(cacheId);

      // Tạo link download đầy đủ với cacheId đã mã hóa và streamPath từ .env
      const linkDownload = `${req.protocol}://${req.headers.host}${STREAM_PATH_URL}/${encodedCacheId}`;

      return res.json({ id, title, thumbnail, cacheId, linkDownload });
    } catch (proxyError) {
      console.error('[Main] All methods failed:', {
        ytDlpError: ytDlpError.message,
        proxyError: proxyError.message,
      });
      return res.status(500).json({
        error: 'ALL_METHODS_FAILED',
        details: {
          ytDlpError: ytDlpError.message,
          proxyError: proxyError.message,
        },
      });
    }
  }
});

// Route trả về link ảo khi nhấn Download
app.get('/get-stream/:id', async (req, res) => {
  const encodedId = req.params.id;
  let id;
  try {
    id = decodeBase64(encodedId);
  } catch (error) {
    console.error('[Main] Invalid Base64 ID:', encodedId);
    return res.status(400).json({ error: 'INVALID_ENCODED_ID' });
  }

  getCache(id, (entry) => {
    if (!entry) {
      return res.status(404).json({ error: 'VIRTUAL_LINK_NOT_FOUND' });
    }

    // Tạo link ảo đầy đủ với cacheId đã mã hóa
    const virtualLink = `${req.protocol}://${req.headers.host}${STREAM_PATH_URL}/${encodedId}`;
    return res.json({ streamUrl: virtualLink });
  });
});

// Route stream video từ link ảo
app.get(STREAM_PATH_URL + '/:id', concurrentLimitMiddleware, async (req, res) => {
  const encodedId = req.params.id;
  let id;
  try {
    id = decodeBase64(encodedId);
  } catch (error) {
    console.error('[Main] Invalid Base64 ID:', encodedId);
    return res.status(400).json({ error: 'INVALID_ENCODED_ID' });
  }

  getCache(id, async (entry) => {
    if (!entry) {
      return res.status(404).json({ error: 'VIRTUAL_LINK_NOT_FOUND' });
    }

    const { videoUrl, streamUrl } = entry;

    try {
      if (streamUrl) {
        // Sử dụng streamUrl từ yt-dlp nếu có
        console.log('[Main] Using cached stream URL for ID:', id);
        const cookieContent = parseCookies(COOKIES_PATH);
        const response = await axios.get(streamUrl, {
          responseType: 'stream',
          headers: {
            'User-Agent': TIKTOK_USER_AGENT,
            'Referer': 'https://www.tiktok.com/',
            'Cookie': cookieContent,
            'Accept': 'video/mp4',
          },
        });
        res.setHeader('Content-Type', 'video/mp4');
        response.data.pipe(res);
      } else {
        // Fallback: Proxy trực tiếp
        console.log('[Main] Attempting proxy method for ID:', id);
        const { stream } = await fetchWithProxy(videoUrl);
        res.setHeader('Content-Type', 'video/mp4');
        stream.pipe(res);
      }
    } catch (error) {
      console.error('[Main] Streaming failed for ID:', id, error.message);
      res.status(500).json({
        error: 'STREAMING_FAILED',
        details: error.message,
      });
    }
  });
});

// Kiểm tra yt-dlp có sẵn không
exec('yt-dlp --version', { shell: true }, (error, stdout, stderr) => {
  if (error || stderr) {
    console.error('[CONFIG] yt-dlp not found or failed:', error?.message || stderr);
    process.exit(1);
  }
  console.log('[CONFIG] yt-dlp version:', stdout.trim());
});

// Khởi động server
app.listen(port, () => {
  console.log(`🚀 Server running at http://localhost:${port}`);
});
