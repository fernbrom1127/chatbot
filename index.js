const express = require('express');
const axios = require('axios');
const multer = require('multer');
const path = require('path');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const cloudinary = require('cloudinary').v2;
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ========== Cloudinary 設定 ==========
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ========== Multer 設定（處理圖片上傳） ==========
const upload = multer({ storage: multer.memoryStorage() });

// ========== Google Sheets 設定 ==========
let googleSheetDoc = null;
let googleSheetReady = false;

async function initGoogleSheets() {
  try {
    console.log('🔧 開始初始化 Google Sheets...');
    
    const client_email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    const private_key = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
    const sheetId = process.env.GOOGLE_SHEET_ID;
    
    if (!client_email || !private_key || !sheetId) {
      console.log('⚠️ 缺少 Google Sheets 環境變數');
      return false;
    }
    
    const auth = new JWT({
      email: client_email,
      key: private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    
    const doc = new GoogleSpreadsheet(sheetId, auth);
    await doc.loadInfo();
    console.log('✅ 文件載入成功');
    googleSheetDoc = doc;
    
    googleSheetReady = true;
    console.log('✅ Google Sheets 連線成功！');
    return true;
  } catch (error) {
    console.error('❌ Google Sheets 連線失敗：', error.message);
    googleSheetReady = false;
    return false;
  }
}

// ========== 儲存聊天紀錄 ==========
async function saveChatMessage(roleId, userId, sender, content, imageUrl) {
  if (!googleSheetReady) return;
  try {
    let chatSheet = googleSheetDoc.sheetsByTitle[`聊天_${roleId}`];
    if (!chatSheet) {
      chatSheet = await googleSheetDoc.addSheet({ 
        title: `聊天_${roleId}`,
        headerValues: ['時間', '使用者ID', '傳送者', '內容', '圖片URL']
      });
      console.log(`✅ 已建立聊天工作表：聊天_${roleId}`);
    }
    await chatSheet.addRow({
      '時間': new Date().toISOString(),
      '使用者ID': userId,
      '傳送者': sender,
      '內容': content || '',
      '圖片URL': imageUrl || ''
    });
  } catch(e) { console.error('儲存聊天失敗', e); }
}

// ========== 載入聊天紀錄 ==========
app.get('/api/chat/messages', async (req, res) => {
  const { roleId, userId } = req.query;
  if (!googleSheetReady) return res.json({ messages: [] });
  try {
    const chatSheet = googleSheetDoc.sheetsByTitle[`聊天_${roleId}`];
    if (!chatSheet) return res.json({ messages: [] });
    const rows = await chatSheet.getRows();
    const messages = [];
    for (const row of rows) {
      if (row.get('使用者ID') === userId) {
        messages.push({
          sender: row.get('傳送者'),
          content: row.get('內容'),
          imageUrl: row.get('圖片URL'),
          timestamp: row.get('時間')
        });
      }
    }
    res.json({ messages });
  } catch(e) { 
    console.error('載入聊天失敗', e);
    res.json({ messages: [] }); 
  }
});

// ========== 上傳圖片到 Cloudinary ==========
async function uploadToCloudinary(imageBuffer) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder: 'hilarious_bot', timeout: 30000 },
      (error, result) => {
        if (error) return reject(error);
        if (result && result.secure_url) resolve(result.secure_url);
        else reject(new Error('Cloudinary 未回傳網址'));
      }
    );
    uploadStream.end(imageBuffer);
  });
}

// ========== 呼叫 DeepSeek API ==========
async function callDeepSeek(roleName, roleDescription, userMessage) {
  try {
    const response = await axios.post('https://api.deepseek.com/chat/completions', {
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: `你是「${roleName}」。${roleDescription}請用這個角色的語氣回應。保持簡短有趣，不超過50字。` },
        { role: 'user', content: userMessage }
      ],
      temperature: 0.9,
      max_tokens: 150
    }, {
      headers: { 
        'Content-Type': 'application/json', 
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` 
      },
      timeout: 15000
    });
    return response.data.choices[0].message.content;
  } catch(e) {
    console.error('DeepSeek 錯誤:', e.message);
    return null;
  }
}

// ========== 發送文字訊息 ==========
app.post('/api/chat/send', async (req, res) => {
  const { roleId, roleName, roleDescription, userId, message } = req.body;
  
  if (!message || !message.trim()) {
    return res.status(400).json({ error: '訊息不能為空' });
  }
  
  // 儲存使用者訊息
  await saveChatMessage(roleId, userId, 'user', message, null);
  
  // 呼叫 DeepSeek
  let reply = await callDeepSeek(roleName, roleDescription, message);
  
  if (!reply) {
    reply = `噗～ ${roleName} 暫時無法回應，不愧是我！`;
  }
  
  // 儲存 AI 回覆
  await saveChatMessage(roleId, userId, 'bot', reply, null);
  
  res.json({ reply });
});

// ========== 上傳圖片 ==========
app.post('/api/chat/upload', upload.single('image'), async (req, res) => {
  const { roleId, roleName, roleDescription, userId } = req.body;
  const imageFile = req.file;
  
  if (!imageFile) {
    return res.status(400).json({ error: '無圖片' });
  }
  
  try {
    // 上傳到 Cloudinary
    const imageUrl = await uploadToCloudinary(imageFile.buffer);
    if (!imageUrl) {
      return res.status(500).json({ error: '圖片上傳失敗' });
    }
    
    // 儲存使用者圖片訊息
    await saveChatMessage(roleId, userId, 'user', '📸 傳送了一張圖片', imageUrl);
    
    // 隨機決定是否丟圖（30% 機率）
    const sendImage = Math.random() < 0.3;
    let replyImageUrl = null;
    if (sendImage) {
      replyImageUrl = 'https://picsum.photos/200/200?random=' + Date.now();
    }
    
    // 呼叫 DeepSeek 產生幹話回覆
    let reply = await callDeepSeek(roleName, roleDescription, '（傳送了一張圖片）');
    
    if (!reply) {
      reply = `噗～ 這張圖... ${roleName} 覺得很有趣！不愧是我。`;
    }
    
    // 儲存 AI 回覆
    await saveChatMessage(roleId, userId, 'bot', reply, replyImageUrl);
    
    res.json({ reply, imageUrl: replyImageUrl });
    
  } catch (error) {
    console.error('圖片處理錯誤:', error);
    res.status(500).json({ error: '處理失敗' });
  }
});

// ========== 取得角色列表（可從 Google Sheets 讀取，先寫死） ==========
// ========== 取得角色列表（從 Google Sheets 讀取） ==========
app.get('/api/roles', async (req, res) => {
  if (!googleSheetReady) {
    return res.status(503).json({ error: '服務未就緒' });
  }
  
  try {
    let roleSheet = googleSheetDoc.sheetsByTitle['角色設定'];
    if (!roleSheet) {
      return res.json([]);
    }
    
    const rows = await roleSheet.getRows();
    const roles = [];
    for (const row of rows) {
      roles.push({
        id: row.get('角色ID'),
        name: row.get('名稱'),
        avatar: row.get('頭像URL'),
        description: row.get('角色提示詞')
      });
    }
    res.json(roles);
  } catch (error) {
    console.error('讀取角色失敗:', error);
    res.status(500).json({ error: error.message });
  }
});
// ========== 靜態頁面 ==========
app.get('/hilarious', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'hilarious.html'));
});

app.get('/', (req, res) => {
  res.redirect('/hilarious');
});

// ========== 健康檢查 ==========
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// ========== 啟動伺服器 ==========
const port = process.env.PORT || 3000;

app.listen(port, async () => {
  console.log(`🚀 搞笑機器人啟動，port: ${port}`);
  console.log(`📍 網址：https://fbtestbot.onrender.com/hilarious`);
  await initGoogleSheets();
  if (googleSheetReady) console.log(`✅ Google Sheets 已就緒`);
});
