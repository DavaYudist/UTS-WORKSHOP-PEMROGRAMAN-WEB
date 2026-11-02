const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config(); // preserves local server port / db overrides if present
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const db = require('./db');
const { encryptData } = require('./cryptoHelper');
const sendWhatsApp = require('./config/middleware/sendWhatsApp');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Default mock records for Server A (Primary)
const DEFAULT_CARS_A = [
  {
    id: 101,
    nama: "Suzuki Ertiga GX [Server A - Utama]",
    nama_mobil: "Suzuki Ertiga GX [Server A - Utama]",
    nama_kategori: "Suzuki Ertiga GX [Server A - Utama]",
    brand: "Suzuki",
    harga: "Rp 150.000.000",
    gambar_mobil: "https://images.unsplash.com/photo-1549399542-7e3f8b79c341?w=400"
  },
  {
    id: 102,
    nama: "Toyota Avanza Veloz [Server A - Utama]",
    nama_mobil: "Toyota Avanza Veloz [Server A - Utama]",
    nama_kategori: "Toyota Avanza Veloz [Server A - Utama]",
    brand: "Toyota",
    harga: "Rp 210.000.000",
    gambar_mobil: "https://images.unsplash.com/photo-1552519507-da3b142c6e3d?w=400"
  }
];

// In-memory car store
let carMemoryStore = [...DEFAULT_CARS_A];

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
      for (const car of DEFAULT_CARS_A) {
        await db.execute(
          'INSERT INTO mobil (id, nama_mobil, brand, harga, gambar_mobil) VALUES (?, ?, ?, ?, ?)',
          [car.id, car.nama_mobil, car.brand, car.harga, car.gambar_mobil]
        );
      }
      console.log('[Server A] Seeded default car records into MySQL mobil table.');
    }
  } catch (err) {
    console.log('[Server A] MySQL not ready/connected. Operating with in-memory store:', err.message);
  }
}
initDbTable();

// Helper to query DB or fallback to memory
async function getCars() {
  return carMemoryStore;
}

// Health check endpoint
app.get('/health', (req, res) => {
  return res.status(200).json({
    status: "ok",
    server: "Server A",
    timestamp: new Date().toISOString()
  });
});

// GET car / category list (Primary)
app.get(['/api/kategori', '/api/kategori/', '/api/mobil', '/api/mobil/'], async (req, res) => {
  try {
    const cars = await getCars();
    return res.status(200).json({
      status: true,
      message: "Data Mobil dari Server A (Utama)",
      data: cars
    });
  } catch (error) {
    console.error('[Server A] Error fetching cars:', error.message);
    return res.status(500).json({
      status: false,
      message: "Gagal mengambil data dari Server A",
      error: error.message
    });
  }
});

// POST sync endpoint from Server B
app.post(['/api/mobil/sync', '/api/kategori/sync'], async (req, res) => {
  try {
    const payload = req.body;
    const items = Array.isArray(payload) ? payload : [payload];
    const syncedItems = [];

    for (const item of items) {
      if (!item || (!item.nama_mobil && !item.nama)) continue;
      const carName = item.nama_mobil || item.nama || item.nama_kategori;

      const record = {
        id: item.id || (100 + carMemoryStore.length + 1),
        nama: carName,
        nama_mobil: carName,
        nama_kategori: carName,
        brand: item.brand || 'Unknown',
        harga: item.harga || '0',
        gambar_mobil: item.gambar_mobil || 'https://images.unsplash.com/photo-1549399542-7e3f8b79c341?w=400'
      };

      const existingIdx = carMemoryStore.findIndex(c => c.id === record.id || c.nama_mobil === record.nama_mobil);
      if (existingIdx >= 0) {
        carMemoryStore[existingIdx] = record;
      } else {
        carMemoryStore.push(record);
      }

      try {
        await db.execute(
          'INSERT INTO mobil (nama_mobil, brand, harga, gambar_mobil) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE brand = VALUES(brand), harga = VALUES(harga), gambar_mobil = VALUES(gambar_mobil)',
          [record.nama_mobil, record.brand, record.harga, record.gambar_mobil]
        );
      } catch (dbErr) {
        // Ignored if DB offline
      }

      syncedItems.push(record);
    }

    console.log(`[Server A] Successfully synced ${syncedItems.length} records from Server B.`);
    return res.status(200).json({
      status: true,
      message: `Berhasil sinkronisasi ${syncedItems.length} data mobil ke Server A`,
      data: syncedItems
    });
  } catch (error) {
    console.error('[Server A] Error syncing data:', error.message);
    return res.status(500).json({
      status: false,
      message: "Gagal melakukan sinkronisasi ke Server A",
      error: error.message
    });
  }
});

// Legacy transmit route
app.post('/transmit', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM produk');
    const encryptedPayload = rows.map((row) => ({
      id: row.id,
      nama_produk: encryptData(row.nama_produk),
      harga_produk: encryptData(row.harga_produk),
      foto_produk: encryptData(row.foto_produk),
      id_kategori: encryptData(row.id_kategori)
    }));

    const response = await axios.post('http://localhost:3002/receive', encryptedPayload);
    return res.status(200).json({
      success: true,
      message: 'Data successfully transmitted to Server B',
      remoteResponse: response.data,
      transmittedPayload: encryptedPayload
    });
  } catch (error) {
    console.error('Error during transmission:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Transmission failed',
      error: error.message
    });
  }
});

// Startup notification
app.listen(PORT, () => {
  console.log(`Server A (Primary) is running on http://localhost:${PORT}`);
  sendWhatsApp('🟢 *[SERVER A ONLINE]*\nServer A (Port 4000) aktif dan siap melayani permintaan.');
});

// Graceful Shutdown notification
let isShuttingDown = false;
const handleShutdown = async (signal) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n[Server A] Received ${signal}. Shutting down gracefully...`);
  try {
    await sendWhatsApp('🔴 *[SERVER A LOSS]*\nServer A (Port 4000) dimatikan / offline. Lalu lintas dialihkan ke Server B.');
  } catch (err) {
    console.error('[Server A] Error sending shutdown WhatsApp alert:', err.message);
  }
  setTimeout(() => {
    process.exit(0);
  }, 1000);
};

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));
