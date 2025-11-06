// index.js - VERSIÓN TEMPORAL PARA AUTORIZACIÓN EN RENDER

const express = require('express');
const cors = require('cors');
const session = require('express-session');
const Keycloak = require('keycloak-connect');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { google } = require('googleapis');
const readline = require('readline');
const Opossum = require('opossum'); // <-- 1. IMPORTAMOS OPOSSUM

// --- CONFIGURACIÓN DE GOOGLE DRIVE ---
const TOKEN_PATH = 'token.json';
const CREDENTIALS_PATH = process.env.RENDER ? '/etc/secrets/oauth_credentials.json' : path.join(__dirname, 'oauth_credentials.json');
const SCOPES = ['https://www.googleapis.com/auth/drive'];
const PARENT_FOLDER_ID = '1MDkQRh6quSH_z9qmnxo_dQCb-1rI1sPm';

// --- 2. CONFIGURACIÓN DEL CIRCUIT BREAKER ---
const circuitBreakerOptions = {
  timeout: 5000, // Si la llamada tarda más de 5s, falla
  errorThresholdPercentage: 50, // Si el 50% de peticiones recientes fallan, abre el circuito
  resetTimeout: 30000 // Después de 30s, prueba una petición de nuevo
};

// --- FUNCIONES DE AUTORIZACIÓN ---
async function authorize() {
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  if (fs.existsSync(TOKEN_PATH)) {
    const token = fs.readFileSync(TOKEN_PATH);
    oAuth2Client.setCredentials(JSON.parse(token));
    console.log("✅ Token de Google Drive cargado desde el archivo.");
    return oAuth2Client;
  }

  console.log("No se encontró un token. Iniciando proceso de autorización...");
  return getAccessToken(oAuth2Client);
}

function getAccessToken(oAuth2Client) {
  return new Promise((resolve, reject) => {
    const authUrl = oAuth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES });
    console.log('-----------------------------------------------------------------');
    console.log('PASO 1: Autoriza esta aplicación visitando esta URL en tu navegador:');
    console.log(authUrl);
    console.log('-----------------------------------------------------------------');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('PASO 2: Ingresa el código que recibiste de la página aquí: ', (code) => {
      rl.close();
      oAuth2Client.getToken(code, (err, token) => {
        if (err) return reject('Error al obtener el token de acceso: ' + err);
        oAuth2Client.setCredentials(token);
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(token));
        console.log('✅ ¡Éxito! Token guardado en', TOKEN_PATH);
        resolve(oAuth2Client);
      });
    });
  });
}

// --- 3. ENVOLVEMOS authorize() CON UN CIRCUIT BREAKER ---
const protectedAuthorize = new Opossum(authorize, circuitBreakerOptions);

// =================================================================
//                      INICIO DEL SERVIDOR
// =================================================================
async function startServer() {
  // =========================================================
  //      EL ÚNICO CAMBIO ESTÁ AQUÍ
  // =========================================================
  
  // const authClient = await protectedAuthorize.fire(); // <-- LÍNEA DESACTIVADA TEMPORALMENTE
  const authClient = await authorize(); // <-- USAMOS ESTA LLAMADA DIRECTA POR AHORA
  
  // =========================================================

  console.log("🔐 Autorización de Google Drive completada.");

  const app = express();
  app.use(cors());

  const memoryStore = new session.MemoryStore();
  app.use(session({
    secret: 'algun-secreto-muy-largo-y-seguro',
    resave: false,
    saveUninitialized: true,
    store: memoryStore
  }));

  const keycloak = new Keycloak({ store: memoryStore });
  app.use(keycloak.middleware());

  // --- Configuración de Multer ---
  const uploadDir = 'uploads/';
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
  const upload = multer({ dest: uploadDir });

  // --- RUTA PROTEGIDA DE PRUEBA ---
  app.get('/api/protegida', keycloak.protect(), (req, res) => {
    const userInfo = req.kauth.grant.access_token.content;
    res.json({
      message: `Hola, ${userInfo.given_name} ${userInfo.family_name}! Esta es una ruta protegida.`,
      email: userInfo.email,
      username: userInfo.preferred_username
    });
  });

  // =========================================================
  //      RUTA: SUBIDA DE DOCUMENTOS A GOOGLE DRIVE
  // =========================================================
  app.post('/api/upload', keycloak.protect(), upload.fields([
    { name: 'documentoIdentidad', maxCount: 1 },
    { name: 'formatoMaterias', maxCount: 1 },
    { name: 'seguro', maxCount: 1 },
    { name: 'cartaAceptacion', maxCount: 1 },
    { name: 'cartaRecomendacion', maxCount: 1 }
  ]), async (req, res) => {

    const uploadCircuit = new Opossum(async () => {
      const driveService = google.drive({ version: 'v3', auth: authClient });
      const userInfo = req.kauth.grant.access_token.content;
      const studentFolderName = `${userInfo.family_name}_${userInfo.given_name}_${userInfo.preferred_username}`;

      // Buscar o crear carpeta
      const searchResponse = await driveService.files.list({
        q: `mimeType='application/vnd.google-apps.folder' and name='${studentFolderName}' and trashed = false`,
        fields: 'files(id, name)',
      });

      let studentFolderId;
      if (searchResponse.data.files.length === 0) {
        const folderMetadata = {
          name: studentFolderName,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [PARENT_FOLDER_ID]
        };
        const createResponse = await driveService.files.create({
          resource: folderMetadata,
          fields: 'id'
        });
        studentFolderId = createResponse.data.id;
      } else {
        studentFolderId = searchResponse.data.files[0].id;
      }

      // Subida de archivos
      const files = req.files;
      const uploadPromises = [];
      for (const fieldName in files) {
        const file = files[fieldName][0];
        const fileMetadata = { name: file.originalname, parents: [studentFolderId] };
        const media = { mimeType: file.mimetype, body: fs.createReadStream(file.path) };
        uploadPromises.push(driveService.files.create({ resource: fileMetadata, media: media, fields: 'id' }));
      }

      await Promise.all(uploadPromises);
      return 'Archivos subidos correctamente.';
    }, circuitBreakerOptions);

    uploadCircuit.on('open', () => console.log('⚠️ CIRCUITO ABIERTO: Google Drive no responde.'));
    uploadCircuit.on('close', () => console.log('✅ CIRCUITO CERRADO: Google Drive se ha recuperado.'));

    try {
      await uploadCircuit.fire();
      res.status(200).json({ message: '✅ Archivos subidos a Google Drive correctamente.' });
    } catch (error) {
      console.error('❌ Error en el Circuit Breaker de subida:', error.message);
      res.status(503).json({ message: 'El servicio de almacenamiento no está disponible. Intente más tarde.' });
    } finally {
      // Limpieza de archivos temporales
      for (const fieldName in req.files) {
        fs.unlink(req.files[fieldName][0].path, () => {});
      }
    }
  });

  // =========================================================
  //      RUTA: CONSULTA DE ESTADO DE DOCUMENTOS
  // =========================================================
  app.get('/api/status', keycloak.protect(), async (req, res) => {
    const statusCircuit = new Opossum(async () => {
      const driveService = google.drive({ version: 'v3', auth: authClient });
      const userInfo = req.kauth.grant.access_token.content;
      const studentFolderName = `${userInfo.family_name}_${userInfo.given_name}_${userInfo.preferred_username}`;

      const searchFolderResponse = await driveService.files.list({
        q: `mimeType='application/vnd.google-apps.folder' and name='${studentFolderName}' and trashed = false`,
        fields: 'files(id, name)',
      });

      if (searchFolderResponse.data.files.length === 0) {
        return { status: 'No encontrado', uploadedFiles: [] };
      }

      const studentFolderId = searchFolderResponse.data.files[0].id;
      const searchFilesResponse = await driveService.files.list({
        q: `'${studentFolderId}' in parents and trashed = false`,
        fields: 'files(name)',
      });

      const uploadedFiles = searchFilesResponse.data.files.map(f => f.name);
      return { status: 'Encontrado', uploadedFiles };
    }, circuitBreakerOptions);

    try {
      const result = await statusCircuit.fire();
      res.status(200).json(result);
    } catch (error) {
      console.error('❌ Error en el Circuit Breaker de status:', error.message);
      res.status(503).json({ message: 'El servicio de almacenamiento no está disponible. Intente más tarde.' });
    }
  });

  // --- INICIO DEL SERVIDOR ---
  const PORT = 3000;
  app.listen(PORT, () => console.log(`🚀 Servidor Backend corriendo en http://localhost:${PORT}`));
}

// --- Iniciar el servidor ---
startServer();