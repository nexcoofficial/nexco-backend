const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");

const serviceAccount = require("/etc/secrets/firebase-key.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("NEXCO BACKEND RUNNING 🚀");
});

app.post("/api/login", async (req, res) => {
  try {
    const { email, key, device_id } = req.body;

    const ref = db.collection("licenses").doc(key);
    const snap = await ref.get();

    if (!snap.exists) {
      return res.status(404).json({
        success: false,
        message: "LICENSE TIDAK DITEMUKAN",
      });
    }

    const data = snap.data();

    if (!data.active) {
      return res.status(403).json({
        success: false,
        message: "LICENSE TIDAK AKTIF",
      });
    }
const now = new Date();
const expired = new Date(data.expired_at);

if (now > expired) {
  return res.status(403).json({
    success: false,
    message: "LICENSE EXPIRED",
  });
}
    if (data.email !== email) {
      return res.status(403).json({
        success: false,
        message: "EMAIL TIDAK SESUAI",
      });
    }

    if (
      data.active_device_id &&
      data.active_device_id !== device_id
    ) {
      return res.status(403).json({
        success: false,
        message: "AKUN SUDAH DIGUNAKAN DI DEVICE LAIN",
      });
    }

    await ref.update({
      active_device_id: device_id,
      last_login: new Date().toISOString(),
    });

    return res.json({
      success: true,
      message: "LOGIN BERHASIL",
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      message: "SERVER ERROR",
    });
  }
});
app.post("/api/create-payment", async (req, res) => {
  try {

    const { email, package_name } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "EMAIL WAJIB",
      });
    }

    return res.json({
      success: true,
      message: "CREATE PAYMENT SUCCESS",
      email,
      package_name: package_name || "basic"
    });

  } catch (err) {
    console.error(err);

    return res.status(500).json({
      success: false,
      message: "SERVER ERROR",
    });
  }
});
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("API RUNNING");
});