const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config(); // preserves local server port / db overrides if present
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const db = require('./db');
const { decryptData } = require('./cryptoHelper');
const sendWhatsApp = require('./config/middleware/sendWhatsApp');

const app = express();
const PORT = process.env.PORT || 3100;
const SERVER_A_URL = process.env.SERVER_A_URL || 'http://localhost:4000';

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

let pendingSyncList = [];

// State Tracking Variables (strictly in-memory)
let wasServerAOffline = false; // Latch flag to ensure alerts are sent only once per state change
let isCheckingHealth = false;

// Default fallback records for Server B
const DEFAULT_FALLBACK_CARS = [
  {
    id: 201,
    nama: "Ford Ranger Raptor [Server B - Fallback]",
    nama_mobil: "Ford Ranger Raptor [Server B - Fallback]",
    nama_kategori: "Ford Ranger Raptor [Server B - Fallback]",
    brand: "Ford",
    harga: "Rp 1.150.000.000",
    gambar_mobil: "https://images.unsplash.com/photo-1533473359331-0135ef1b58bf?w=400"
  },
  {
    id: 202,
    nama: "Honda Civic Turbo [Server B - Fallback]",
    nama_mobil: "Honda Civic Turbo [Server B - Fallback]",
    nama_kategori: "Honda Civic Turbo [Server B - Fallback]",
    brand: "Honda",
    harga: "Rp 450.000.000",
    gambar_mobil: "https://images.unsplash.com/photo-1606611013016-969c19ba27bb?w=400"
  }
];

let carMemoryStoreB = [...DEFAULT_FALLBACK_CARS];

// Initialize DB table if available
async function initDbTable() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS mobil (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nama_mobil VARCHAR(255) NOT NULL,
        brand VARCHAR(100) NOT NULL,
        harga VARCHAR(100) NOT NULL,
        gambar_mobil TEXT
      )
    `);

    const [rows] = await db.query('SELECT COUNT(*) as count FROM mobil');
    if (rows[0].count === 0) {
      for (const car of DEFAULT_FALLBACK_CARS) {
        await db.execute(
          'INSERT INTO mobil (id, nama_mobil, brand, harga, gambar_mobil) VALUES (?, ?, ?, ?, ?)',
          [car.id, car.nama_mobil, car.brand, car.harga, car.gambar_mobil]
        );
      }
      console.log('[Server B] Seeded default fallback records into MySQL mobil table.');
    }
  } catch (err) {
    console.log('[Server B] MySQL not ready/connected. Operating with in-memory store:', err.message);
  }
}
initDbTable();

// Helper to get cars from DB with decryption or fallback to in-memory store
async function getCarsFromDbOrMemory() {
  return carMemoryStoreB;
}

// Health check endpoint
app.get('/health', (req, res) => {
  return res.status(200).json({
    status: "ok",
    server: "Server B",
    pendingCount: pendingSyncList.length,
    timestamp: new Date().toISOString()
  });
});

// GET car / category list (Fallback)
app.get([
  '/apiserverb/kategori',
  '/apiserverb/kategori/',
  '/apiserverb/mobil',
  '/apiserverb/mobil/'
], async (req, res) => {
  try {
    const cars = await getCarsFromDbOrMemory();
    return res.status(200).json({
      status: true,
      message: "Data Mobil dari Server B (Fallback)",
      data: cars
    });
  } catch (error) {
    console.error('[Server B] Error fetching cars:', error.message);
    return res.status(500).json({
      status: false,
      message: "Gagal mengambil data dari Server B",
      error: error.message
    });
  }
});

// POST new car to Server B with immediate sync or queueing
app.post([
  '/apiserverb/mobil',
  '/apiserverb/mobil/',
  '/apiserverb/kategori',
  '/apiserverb/kategori/'
], async (req, res) => {
  try {
    const { nama_mobil, nama, brand, harga, gambar_mobil } = req.body;
    const carName = nama_mobil || nama;

    if (!carName) {
      return res.status(400).json({
        status: false,
        message: "Nama mobil wajib diisi"
      });
    }

    const newCar = {
      id: 200 + carMemoryStoreB.length + 1,
      nama: String(carName).trim(),
      nama_mobil: String(carName).trim(),
      nama_kategori: String(carName).trim(),
      brand: brand ? String(brand).trim() : 'Lainnya',
      harga: harga ? String(harga).trim() : 'Rp 0',
      gambar_mobil: gambar_mobil || 'https://images.unsplash.com/photo-1533473359331-0135ef1b58bf?w=400'
    };

    // 1. Store locally in Server B
    carMemoryStoreB.push(newCar);
    try {
      await db.execute(
        'INSERT INTO mobil (id, nama_mobil, brand, harga, gambar_mobil) VALUES (?, ?, ?, ?, ?)',
        [newCar.id, newCar.nama_mobil, newCar.brand, newCar.harga, newCar.gambar_mobil]
      );
    } catch (dbErr) {
      // Ignored if DB offline
    }

    // 2. Attempt immediate sync to Server A
    let isQueued = false;
    try {
      await axios.post(`${SERVER_A_URL}/api/mobil/sync`, [newCar], { timeout: 2000 });
      console.log(`[Server B] Immediate sync to Server A succeeded for: ${newCar.nama_mobil}`);
    } catch (syncErr) {
      console.log(`[Server B] Server A unreachable (${syncErr.message}). Added to pendingSyncList.`);
      pendingSyncList.push(newCar);
      isQueued = true;
    }

    // 3. Return confirmation
    return res.status(201).json({
      status: true,
      message: "Mobil berhasil disimpan di Server B",
      queued: isQueued,
      pendingSyncCount: pendingSyncList.length,
      data: newCar
    });
  } catch (error) {
    console.error('[Server B] Error creating car:', error.message);
    return res.status(500).json({
      status: false,
      message: "Gagal menyimpan mobil di Server B",
      error: error.message
    });
  }
});

// Sync status inspection endpoint
app.get('/apiserverb/sync-status', (req, res) => {
  return res.status(200).json({
    status: true,
    server: "Server B",
    pendingSyncCount: pendingSyncList.length,
    pendingSyncList: pendingSyncList
  });
});

// Flush / Sync pending queue to Server A
const flushPendingQueueToA = async () => {
  if (pendingSyncList.length === 0) {
    console.log('[Sync] No pending queue data to flush to Server A.');
    return;
  }
  try {
    const itemsToSync = [...pendingSyncList];
    console.log(`[Sync] Flushing ${itemsToSync.length} items from local pending queue to Server A...`);
    const syncRes = await axios.post(`${SERVER_A_URL}/api/mobil/sync`, itemsToSync, { timeout: 5000 });
    if (syncRes.status === 200 || syncRes.status === 201) {
      pendingSyncList = [];
      console.log('[Sync] Local pending queue successfully flushed to Server A.');
    }
  } catch (error) {
    console.error('[Sync Error] Failed to flush pending queue to Server A:', error.message);
  }
};

// 5-second interval health checker & auto-sync worker monitoring Server A
const checkServerAHealth = async () => {
  if (isCheckingHealth) return;
  isCheckingHealth = true;

  try {
    const res = await axios.get(`${SERVER_A_URL}/health`, { timeout: 3000 });

    if (res.status === 200 || (res.data && res.data.status === 'ok')) {
      if (wasServerAOffline) {
        wasServerAOffline = false;
        console.log('[Health Check] Server A recovered. Sending recovery notification...');
        await sendWhatsApp('✅ *[SERVER A RECOVERED]*\nServer A kembali online. Sinkronisasi data tertunda dari Server B ke Server A dimulai.');
        await flushPendingQueueToA();
      } else if (pendingSyncList.length > 0) {
        // Auto-sync worker when Server A is online and pending items exist
        await flushPendingQueueToA();
      }
    } else {
      throw new Error(`Server A responded with status ${res.status}`);
    }
  } catch (error) {
    if (!wasServerAOffline) {
      wasServerAOffline = true;
      console.log('[Health Check] Server A failed / unreachable:', error.message);
      await sendWhatsApp('⚠️ *[FAILOVER TRIGGERED]*\nServer A terdeteksi mati! Server B (Port 3100) otomatis mengambil alih permintaan katalog mobil.');
    }
    // If wasServerAOffline === true, do NOT send any message (silent polling).
  } finally {
    isCheckingHealth = false;
  }
};

setInterval(checkServerAHealth, 5000);

// Legacy routes preserved for compatibility
app.post('/receive', async (req, res) => {
  try {
    const dataList = Array.isArray(req.body) ? req.body : [req.body];
    const insertQuery = 'INSERT INTO produk (id, nama_produk, harga_produk, foto_produk, id_kategori) VALUES (?, ?, ?, ?, ?)';

    for (const item of dataList) {
      try {
        await db.execute(insertQuery, [
          item.id,
          item.nama_produk,
          item.harga_produk,
          item.foto_produk,
          item.id_kategori
        ]);
      } catch (e) {
        // DB offline
      }
    }

    return res.status(200).json({
      success: true,
      message: 'Encrypted data received and stored in database'
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to receive and store data',
      error: error.message
    });
  }
});

app.get('/endpoint/data', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM produk');
    const decryptedData = rows.map((row) => ({
      id: row.id,
      nama_produk: decryptData(row.nama_produk),
      harga_produk: decryptData(row.harga_produk),
      foto_produk: decryptData(row.foto_produk),
      id_kategori: decryptData(row.id_kategori)
    }));
    return res.status(200).json(decryptedData);
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve data',
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server B (Fallback & Sync) is running on http://localhost:${PORT}`);
});
