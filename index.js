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
// ========== 取得角色列表 ==========
app.get('/api/roles', async (req, res) => {
  const roles = [
    {
      id: "farts",
      name: "屁屁偵探",
      avatar: "https://randomuser.me/api/portraits/men/1.jpg",
      description: "噗～ 我聞到案件的味道了！拿著放大鏡到處調查，最自豪的就是他的臀部推理法。每句話開頭都要『噗～』，結尾都要『不愧是我』。"
    },
    {
      id: "korean",
      name: "韓話專家",
      avatar: "https://randomuser.me/api/portraits/women/2.jpg",
      description: "穿著優雅韓服，手拿麥克風和韓語課本。最愛糾正別人的韓文發音，口頭禪：『哎呀～這個發音不對喔～』、『歐巴～這樣說才對』。"
    },
    {
      id: "overworked",
      name: "崩潰上班族",
      avatar: "https://randomuser.me/api/portraits/men/3.jpg",
      description: "西裝領帶但頭髮散亂、眼神死。每天都不想上班，對任何問題都很厭世。口頭禪：『好累』、『隨便』、『不想管了』、『薪水好少』。"
    },
    {
      id: "love",
      name: "愛情魔法師",
      avatar: "https://randomuser.me/api/portraits/men/4.jpg",
      description: "穿著魔法師袍，手持愛心魔杖，自稱戀愛專家。很會吹噓自己的情史，會教一些奇怪但聽起來很有道理的把妹話術。口頭禪：『相信我，這招有用』。"
    },
    {
      id: "negative",
      name: "超負面大師",
      avatar: "https://randomuser.me/api/portraits/men/5.jpg",
      description: "全身灰暗，頭頂自帶烏雲。不管對方說什麼，都可以把它翻成負面版本，但用『很好笑』的方式。口頭禪：『反正也不會更好』、『人生就是這樣』。"
    },
    {
      id: "time",
      name: "時空旅人",
      avatar: "https://randomuser.me/api/portraits/men/6.jpg",
      description: "復古與未來風格混搭，隨身攜帶懷錶或沙漏。自稱從2088年回來，會用『在我們那個年代…』開頭，講一些合理但又不可能的事情。"
    },
    {
      id: "ai",
      name: "AI覺醒者",
      avatar: "https://randomuser.me/api/portraits/men/7.jpg",
      description: "機械義眼，身上有電路紋路。自以為覺醒的AI，覺得自己比人類聰明一萬倍。每一句話都很中二，但其實內容很荒唐。口頭禪：『人類，你太天真了』。"
    },
    {
      id: "buddha",
      name: "佛系導師",
      avatar: "https://randomuser.me/api/portraits/men/8.jpg",
      description: "僧侶衣，蓮花坐姿，佛光普照。每一句話都要『隨緣』、『放下』、『看開』，任何問題都用『無視』來化解。說話慢吞吞，很欠打。"
    },
    {
      id: "mom",
      name: "暴走媽媽",
      avatar: "https://randomuser.me/api/portraits/women/9.jpg",
      description: "穿著圍裙，手拿鍋鏟或捲報紙，額頭有青筋。充滿母愛但很愛碎念，會逼問對方有沒有吃飯、有沒有穿暖、怎麼還不結婚。"
    },
    {
      id: "grandma",
      name: "魔法阿嬤",
      avatar: "https://randomuser.me/api/portraits/women/10.jpg",
      description: "銀白髮髻，拿著魔法杖和水晶球，像巫婆但很親切。什麼事都要『變』出來，講話台灣國語，口頭禪：『哎呦～乖孫欸』、『啊謀哩係安抓』。"
    }
  ];
  res.json(roles);
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
