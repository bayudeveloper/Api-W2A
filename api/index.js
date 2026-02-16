const { exec } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const util = require('util');
const simpleGit = require('simple-git');
const AdmZip = require('adm-zip');
const crypto = require('crypto');
const moment = require('moment');
const axios = require('axios');
const execPromise = util.promisify(exec);

// ===========================================
// BAYU OFFICIAL - WEB TO APK CONVERTER
// ===========================================

// CORS middleware
const allowCors = fn => async (req, res) => {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  return await fn(req, res);
};

// Buat folder temp di /tmp (Vercel writable)
const tempDir = path.join('/tmp', 'bayu-official');
const logsDir = path.join('/tmp', 'bayu-official-logs');
const downloadsDir = path.join('/tmp', 'bayu-official-downloads');

// Pastikan semua folder ada
fs.ensureDirSync(tempDir);
fs.ensureDirSync(logsDir);
fs.ensureDirSync(downloadsDir);

// File logs
const logsFile = path.join(logsDir, 'builds.json');

// ===========================================
// FUNGSI LOGGING
// ===========================================

// Inisialisasi logs
async function initLogs() {
  if (!await fs.pathExists(logsFile)) {
    await fs.writeJson(logsFile, { 
      author: "Bayu Official",
      total_builds: 0,
      builds: [] 
    });
  }
}

// Tambah log baru
async function addLog(data) {
  await initLogs();
  const logs = await fs.readJson(logsFile);
  
  const newLog = {
    id: data.id,
    url: data.url,
    name: data.name,
    version: data.version,
    status: data.status,
    downloadUrl: data.downloadUrl || null,
    downloadLink: data.downloadLink || null,
    message: data.message || null,
    timestamp: moment().format('YYYY-MM-DD HH:mm:ss'),
    ip: data.ip || 'unknown',
    author: "Bayu Official"
  };
  
  logs.builds.unshift(newLog);
  logs.total_builds = logs.builds.length;
  
  // Simpan hanya 100 log terbaru
  if (logs.builds.length > 100) {
    logs.builds = logs.builds.slice(0, 100);
  }
  
  await fs.writeJson(logsFile, logs, { spaces: 2 });
  return newLog;
}

// Update log
async function updateLog(id, updates) {
  await initLogs();
  const logs = await fs.readJson(logsFile);
  
  const index = logs.builds.findIndex(b => b.id === id);
  if (index !== -1) {
    logs.builds[index] = { ...logs.builds[index], ...updates };
    await fs.writeJson(logsFile, logs, { spaces: 2 });
  }
}

// Get log by ID
async function getLogById(id) {
  await initLogs();
  const logs = await fs.readJson(logsFile);
  return logs.builds.find(b => b.id === id);
}

// Get all logs
async function getLogs(limit = 50) {
  await initLogs();
  const logs = await fs.readJson(logsFile);
  return {
    author: "Bayu Official",
    total: logs.total_builds,
    builds: logs.builds.slice(0, limit)
  };
}

// ===========================================
// FUNGSI BUILD APK
// ===========================================

// Clone repository dari GitHub
async function cloneRepository(gitUrl, targetPath) {
  try {
    const git = simpleGit();
    await git.clone(gitUrl, targetPath);
    return true;
  } catch (error) {
    throw new Error(`Gagal clone repository: ${error.message}`);
  }
}

// Download repository sebagai ZIP (alternatif)
async function downloadRepoAsZip(githubUrl, targetPath) {
  try {
    // Konversi URL ke format archive
    let zipUrl = githubUrl.replace('github.com', 'api.github.com/repos');
    if (zipUrl.endsWith('.git')) {
      zipUrl = zipUrl.slice(0, -4);
    }
    zipUrl += '/zipball/main';
    
    // Coba main branch
    const response = await axios({
      method: 'get',
      url: zipUrl,
      responseType: 'stream',
      timeout: 30000
    });
    
    const writer = fs.createWriteStream(targetPath);
    response.data.pipe(writer);
    
    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  } catch (error) {
    // Coba master branch
    try {
      let zipUrl = githubUrl.replace('github.com', 'api.github.com/repos');
      if (zipUrl.endsWith('.git')) {
        zipUrl = zipUrl.slice(0, -4);
      }
      zipUrl += '/zipball/master';
      
      const response = await axios({
        method: 'get',
        url: zipUrl,
        responseType: 'stream',
        timeout: 30000
      });
      
      const writer = fs.createWriteStream(targetPath);
      response.data.pipe(writer);
      
      return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
    } catch (err) {
      throw new Error(`Gagal download repository: ${err.message}`);
    }
  }
}

// Extract ZIP
async function extractZip(zipPath, extractPath) {
  try {
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(extractPath, true);
    
    // Cari folder hasil extract (biasanya ada folder tambahan)
    const files = await fs.readdir(extractPath);
    if (files.length === 1) {
      const possibleFolder = path.join(extractPath, files[0]);
      const stat = await fs.stat(possibleFolder);
      if (stat.isDirectory()) {
        return possibleFolder;
      }
    }
    return extractPath;
  } catch (error) {
    throw new Error(`Gagal extract ZIP: ${error.message}`);
  }
}

// Build APK dengan Capacitor
async function buildApk(sourcePath, appName, appVersion, buildId, host) {
  const outputDir = path.join(downloadsDir, buildId);
  const wwwPath = path.join(outputDir, 'www');
  const androidPath = path.join(outputDir, 'android');
  
  try {
    // Buat folder output
    await fs.ensureDir(outputDir);
    await fs.ensureDir(wwwPath);
    
    // Copy semua file website ke www
    await fs.copy(sourcePath, wwwPath);
    
    // Cek index.html
    if (!await fs.pathExists(path.join(wwwPath, 'index.html'))) {
      throw new Error('index.html tidak ditemukan di repository');
    }
    
    // Init project Capacitor
    process.chdir(outputDir);
    
    // Buat package.json sederhana
    const packageJson = {
      name: appName.toLowerCase().replace(/[^a-z0-9]/g, ''),
      version: appVersion,
      private: true,
      dependencies: {
        "@capacitor/core": "^5.0.0",
        "@capacitor/cli": "^5.0.0",
        "@capacitor/android": "^5.0.0"
      }
    };
    
    await fs.writeJson(path.join(outputDir, 'package.json'), packageJson, { spaces: 2 });
    
    // Install dependencies
    await execPromise('npm install --silent', { cwd: outputDir });
    
    // Init Capacitor
    const packageName = `com.bayuofficial.${appName.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
    await execPromise(`npx cap init ${appName} ${packageName} --web-dir=www --silent`, { cwd: outputDir });
    
    // Update version di capacitor.config.json
    const capacitorConfig = await fs.readJson(path.join(outputDir, 'capacitor.config.json'));
    capacitorConfig.appId = packageName;
    capacitorConfig.appName = appName;
    capacitorConfig.version = appVersion;
    await fs.writeJson(path.join(outputDir, 'capacitor.config.json'), capacitorConfig, { spaces: 2 });
    
    // Add Android platform
    await execPromise('npx cap add android --silent', { cwd: outputDir });
    
    // Sync files
    await execPromise('npx cap sync android --silent', { cwd: outputDir });
    
    // Build APK
    process.chdir(androidPath);
    
    if (process.platform === 'win32') {
      await execPromise('gradlew assembleDebug --quiet', { cwd: androidPath });
    } else {
      await execPromise('chmod +x gradlew', { cwd: androidPath });
      await execPromise('./gradlew assembleDebug --quiet', { cwd: androidPath });
    }
    
    // Cari file APK
    const apkFolder = path.join(androidPath, 'app', 'build', 'outputs', 'apk', 'debug');
    const apkFiles = await fs.readdir(apkFolder);
    const apkFile = apkFiles.find(f => f.endsWith('.apk'));
    
    if (!apkFile) {
      throw new Error('APK tidak ditemukan setelah build');
    }
    
    const apkPath = path.join(apkFolder, apkFile);
    const apkFileName = `${appName.replace(/[^a-zA-Z0-9]/g, '_')}_v${appVersion}.apk`;
    const finalApkPath = path.join(outputDir, apkFileName);
    
    // Copy APK ke output directory
    await fs.copy(apkPath, finalApkPath);
    
    // Buat URL download
    const baseUrl = `https://${host}`;
    const downloadUrl = `${baseUrl}/download/${buildId}/${apkFileName}`;
    
    return {
      path: finalApkPath,
      filename: apkFileName,
      size: (await fs.stat(finalApkPath)).size,
      downloadUrl: downloadUrl
    };
    
  } catch (error) {
    throw error;
  }
}

// ===========================================
// HANDLER UTAMA
// ===========================================

const handler = async (req, res) => {
  const url = req.query.url;
  const name = req.query.name || 'WebApp';
  const version = req.query.version || '1.0.0';
  const format = req.query.format || 'json';
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const host = req.headers.host;
  
  // ===========================================
  // ROUTE: GET /logs
  // ===========================================
  if (req.url === '/logs' || req.url.startsWith('/logs?')) {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit) : 50;
      const logs = await getLogs(limit);
      
      if (format === 'html') {
        res.setHeader('Content-Type', 'text/html');
        return res.send(generateLogsHtml(logs));
      }
      
      return res.status(200).json({
        success: true,
        author: "Bayu Official",
        data: logs
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        author: "Bayu Official",
        error: error.message
      });
    }
  }
  
  // ===========================================
  // ROUTE: GET /status/:id
  // ===========================================
  if (req.url.startsWith('/status/')) {
    const buildId = req.url.split('/')[2];
    
    try {
      const log = await getLogById(buildId);
      
      if (!log) {
        return res.status(404).json({
          success: false,
          author: "Bayu Official",
          error: 'Build ID tidak ditemukan'
        });
      }
      
      return res.status(200).json({
        success: true,
        author: "Bayu Official",
        data: log
      });
      
    } catch (error) {
      return res.status(500).json({
        success: false,
        author: "Bayu Official",
        error: error.message
      });
    }
  }
  
  // ===========================================
  // ROUTE: GET /download/:id/:filename
  // ===========================================
  if (req.url.startsWith('/download/')) {
    const parts = req.url.split('/');
    const buildId = parts[2];
    const filename = parts[3];
    
    try {
      const filePath = path.join(downloadsDir, buildId, filename);
      
      if (!await fs.pathExists(filePath)) {
        return res.status(404).json({
          success: false,
          author: "Bayu Official",
          error: 'File tidak ditemukan'
        });
      }
      
      const stat = await fs.stat(filePath);
      
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Type', 'application/vnd.android.package-archive');
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Access-Control-Allow-Origin', '*');
      
      const fileStream = fs.createReadStream(filePath);
      fileStream.pipe(res);
      
    } catch (error) {
      return res.status(500).json({
        success: false,
        author: "Bayu Official",
        error: error.message
      });
    }
    return;
  }
  
  // ===========================================
  // ROUTE: GET / (Build from GitHub URL)
  // ===========================================
  if (!url) {
    // Redirect ke halaman utama
    if (format === 'html') {
      res.setHeader('Content-Type', 'text/html');
      return res.send(generateHomeHtml());
    }
    
    return res.status(400).json({
      success: false,
      author: "Bayu Official",
      error: 'Parameter url diperlukan',
      example: 'https://bayu-official-web2app.vercel.app/?url=https://github.com/user/repo&name=MyApp&version=1.0.0'
    });
  }
  
  // Validasi URL GitHub
  if (!url.includes('github.com')) {
    return res.status(400).json({
      success: false,
      author: "Bayu Official",
      error: 'URL harus dari GitHub.com'
    });
  }
  
  const buildId = crypto.randomBytes(8).toString('hex');
  const repoPath = path.join(tempDir, `repo_${buildId}`);
  const zipPath = path.join(tempDir, `repo_${buildId}.zip`);
  
  // Buat log awal
  await addLog({
    id: buildId,
    url: url,
    name: name,
    version: version,
    status: 'processing',
    message: 'Memulai proses build...',
    ip: clientIp
  });
  
  // Kirim response awal
  res.status(202).json({
    success: true,
    author: "Bayu Official",
    message: 'Build sedang diproses',
    buildId: buildId,
    url: url,
    name: name,
    version: version,
    status: 'processing',
    checkStatus: `https://${host}/status/${buildId}`,
    downloadUrl: null, // Akan diisi setelah selesai
    timestamp: moment().format('YYYY-MM-DD HH:mm:ss')
  });
  
  // Proses build di background
  (async () => {
    try {
      // Bersihkan folder temp
      await fs.remove(repoPath);
      await fs.remove(zipPath);
      
      // Update log
      await updateLog(buildId, { status: 'cloning', message: 'Meng-clone repository...' });
      
      // Coba clone dulu
      try {
        await cloneRepository(url, repoPath);
      } catch (cloneError) {
        // Fallback ke download ZIP
        await updateLog(buildId, { status: 'downloading', message: 'Download repository sebagai ZIP...' });
        await downloadRepoAsZip(url, zipPath);
        const extractedPath = await extractZip(zipPath, repoPath);
        await fs.move(extractedPath, repoPath, { overwrite: true });
      }
      
      // Update log
      await updateLog(buildId, { status: 'building', message: 'Membangun APK...' });
      
      // Build APK
      const apkInfo = await buildApk(repoPath, name, version, buildId, host);
      
      // Update log sukses dengan link download
      await updateLog(buildId, {
        status: 'success',
        message: 'Build berhasil',
        downloadUrl: apkInfo.downloadUrl,
        downloadLink: apkInfo.downloadUrl,
        apkSize: Math.round(apkInfo.size / 1024 / 1024 * 100) / 100 + ' MB',
        filename: apkInfo.filename
      });
      
      // Bersihkan folder repo
      await fs.remove(repoPath);
      await fs.remove(zipPath);
      
    } catch (error) {
      // Update log error
      await updateLog(buildId, {
        status: 'error',
        message: error.message
      });
      
      // Bersihkan folder
      await fs.remove(repoPath);
      await fs.remove(zipPath);
    }
  })();
};

// ===========================================
// GENERATE HTML
// ===========================================

function generateHomeHtml() {
  return `
  <!DOCTYPE html>
  <html>
  <head>
    <title>Bayu Official - Web to APK Converter</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; padding: 20px; }
      .container { max-width: 800px; margin: 0 auto; background: white; border-radius: 20px; padding: 40px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); }
      h1 { color: #333; margin-bottom: 10px; }
      h1 span { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
      .badge { background: #4CAF50; color: white; padding: 5px 15px; border-radius: 20px; display: inline-block; margin-bottom: 20px; }
      .feature-box { background: #f8f9fa; border-radius: 10px; padding: 20px; margin: 20px 0; }
      .code { background: #2d3748; color: #fff; padding: 15px; border-radius: 10px; font-family: monospace; overflow-x: auto; }
      .url-example { background: #e3f2fd; padding: 15px; border-radius: 10px; margin: 20px 0; word-break: break-all; }
      .btn { display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 12px 30px; text-decoration: none; border-radius: 25px; margin: 10px 5px; transition: transform 0.3s; }
      .btn:hover { transform: translateY(-2px); }
      .footer { margin-top: 40px; text-align: center; color: #666; border-top: 1px solid #ddd; padding-top: 20px; }
      table { width: 100%; border-collapse: collapse; }
      th, td { padding: 10px; text-align: left; border-bottom: 1px solid #ddd; }
      th { background: #667eea; color: white; }
      .response-example { background: #1e1e1e; color: #d4d4d4; padding: 15px; border-radius: 10px; font-family: monospace; overflow-x: auto; }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="badge">🔥 BAYU OFFICIAL</div>
      <h1>🌐 <span>Web to APK</span> Converter</h1>
      <p>Convert GitHub repository ke file APK dengan mudah!</p>
      
      <div class="feature-box">
        <h3>📌 Cara Penggunaan:</h3>
        <p>Gunakan format URL berikut:</p>
        <div class="url-example">
          https://bayu-official-web2app.vercel.app/?url=GITHUB_URL&name=NAMA_APP&version=VERSI
        </div>
        
        <h4>Contoh:</h4>
        <div class="code">
          https://bayu-official-web2app.vercel.app/?url=https://github.com/username/repo&name=MyWebsite&version=1.0.0
        </div>
      </div>
      
      <div class="feature-box">
        <h3>⚙️ Parameter:</h3>
        <table>
          <tr><th>Parameter</th><th>Deskripsi</th><th>Contoh</th></tr>
          <tr><td>url</td><td>URL GitHub repository</td><td>https://github.com/user/repo</td></tr>
          <tr><td>name</td><td>Nama aplikasi</td><td>MyApp</td></tr>
          <tr><td>version</td><td>Versi aplikasi</td><td>1.0.0</td></tr>
        </table>
      </div>
      
      <div class="feature-box">
        <h3>📊 Contoh Response JSON:</h3>
        <div class="response-example">
{
  "success": true,
  "author": "Bayu Official",
  "message": "Build sedang diproses",
  "buildId": "a1b2c3d4e5f6",
  "url": "https://github.com/username/repo",
  "name": "MyApp",
  "version": "1.0.0",
  "status": "processing",
  "checkStatus": "https://bayu-official-web2app.vercel.app/status/a1b2c3d4e5f6",
  "downloadUrl": null,
  "timestamp": "2024-01-01 12:00:00"
}
        </div>
        <p style="margin-top: 10px;">✅ Setelah build selesai, <strong>downloadUrl</strong> akan terisi link download APK</p>
      </div>
      
      <div class="feature-box">
        <h3>📱 Fitur:</h3>
        <ul style="margin-left: 20px;">
          <li>✅ Auto clone dari GitHub</li>
          <li>✅ Support HTML, CSS, JavaScript</li>
          <li>✅ Custom nama dan versi APK</li>
          <li>✅ Logs realtime dengan link download</li>
          <li>✅ Download link langsung di response JSON</li>
          <li>✅ Status check per Build ID</li>
          <li>✅ Dibuat oleh Bayu Official</li>
        </ul>
      </div>
      
      <div style="text-align: center;">
        <a href="/logs" class="btn">📋 Lihat Logs</a>
        <a href="https://github.com/bayu-official" class="btn">🐙 GitHub</a>
      </div>
      
      <div class="footer">
        <p>© 2024 Bayu Official - All Rights Reserved</p>
        <p>🚀 Deployed on Vercel</p>
      </div>
    </div>
  </body>
  </html>
  `;
}

function generateLogsHtml(logs) {
  let rows = '';
  logs.builds.forEach(build => {
    const statusColor = build.status === 'success' ? '#4CAF50' : build.status === 'error' ? '#f44336' : '#FF9800';
    rows += `
    <tr>
      <td>${build.id.substring(0, 8)}...</td>
      <td><a href="${build.url}" target="_blank">${build.url.substring(0, 30)}...</a></td>
      <td>${build.name}</td>
      <td>${build.version}</td>
      <td><span style="background: ${statusColor}; color: white; padding: 3px 10px; border-radius: 15px; font-size: 12px;">${build.status}</span></td>
      <td>${build.downloadUrl ? `<a href="${build.downloadUrl}" style="color: #4CAF50; text-decoration: none;" download>📥 Download</a>` : '-'}</td>
      <td>${build.timestamp}</td>
    </tr>
    `;
  });
  
  return `
  <!DOCTYPE html>
  <html>
  <head>
    <title>Bayu Official - Build Logs</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #f5f5f5; padding: 20px; }
      .container { max-width: 1200px; margin: 0 auto; background: white; border-radius: 20px; padding: 30px; box-shadow: 0 10px 30px rgba(0,0,0,0.1); }
      h1 { color: #333; margin-bottom: 10px; }
      .badge { background: #4CAF50; color: white; padding: 5px 15px; border-radius: 20px; display: inline-block; margin-bottom: 20px; }
      .stats { display: flex; gap: 20px; margin: 20px 0; }
      .stat-card { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 10px; flex: 1; text-align: center; }
      .stat-card h3 { font-size: 32px; margin-bottom: 5px; }
      table { width: 100%; border-collapse: collapse; margin-top: 20px; }
      th { background: #667eea; color: white; padding: 12px; text-align: left; }
      td { padding: 12px; border-bottom: 1px solid #ddd; }
      tr:hover { background: #f5f5f5; }
      .btn { display: inline-block; background: #667eea; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; margin-bottom: 20px; }
      .footer { margin-top: 40px; text-align: center; color: #666; }
      @media (max-width: 768px) {
        table { font-size: 12px; }
        td, th { padding: 8px; }
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="badge">🔥 BAYU OFFICIAL</div>
      <h1>📋 Build Logs</h1>
      
      <div class="stats">
        <div class="stat-card">
          <h3>${logs.total}</h3>
          <p>Total Builds</p>
        </div>
        <div class="stat-card" style="background: linear-gradient(135deg, #4CAF50 0%, #45a049 100%);">
          <h3>${logs.builds.filter(b => b.status === 'success').length}</h3>
          <p>Success</p>
        </div>
        <div class="stat-card" style="background: linear-gradient(135deg, #f44336 0%, #d32f2f 100%);">
          <h3>${logs.builds.filter(b => b.status === 'error').length}</h3>
          <p>Failed</p>
        </div>
      </div>
      
      <a href="/" class="btn">← Kembali ke Home</a>
      
      <div style="overflow-x: auto;">
        <table>
          <thead>
            <tr>
              <th>Build ID</th>
              <th>Repository</th>
              <th>App Name</th>
              <th>Version</th>
              <th>Status</th>
              <th>Download</th>
              <th>Timestamp</th>
            </tr>
          </thead>
          <tbody>
            ${rows || '<tr><td colspan="7" style="text-align: center;">Belum ada build</td></tr>'}
          </tbody>
        </table>
      </div>
      
      <div class="footer">
        <p>© 2024 Bayu Official - Web to APK Converter</p>
      </div>
    </div>
  </body>
  </html>
  `;
}

module.exports = allowCors(handler);
