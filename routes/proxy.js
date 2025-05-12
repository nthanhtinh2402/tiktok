import axios from 'axios';

export default (app) => {
  app.get('/video', async (req, res) => {
    const videoUrl = decodeURIComponent(req.query.url || '');

    // Kiểm tra URL hợp lệ
    if (!videoUrl.startsWith('http')) {
      return res.status(400).send('Invalid video URL');
    }

    try {
      // Gửi yêu cầu lấy video từ TikTok
      const response = await axios.get(videoUrl, {
        responseType: 'stream',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Referer': 'https://www.tiktok.com/',
          // Nếu cần có thể thêm cookie
          'Cookie': 'your_cookie_here' // Cookie có thể lấy từ trình duyệt
        }
      });

      // Đặt header Content-Type để video có thể được stream đúng cách
      res.setHeader('Content-Type', 'video/mp4');
      response.data.pipe(res);  // Stream video trực tiếp đến client
    } catch (error) {
      console.error('[Proxy Error]', error.message);
      res.status(500).send('Failed to stream video');
    }
  });
};
