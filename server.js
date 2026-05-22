const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");
const axios = require("axios");
const crypto = require("crypto");
const { Resend } = require("resend");

const serviceAccount = require("/etc/secrets/firebase-key.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const resend = new Resend(process.env.RESEND_API_KEY);

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("NEXCO BACKEND RUNNING 🚀");
});

app.post("/api/login", async (req, res) => {
  try {
    const { email, license_key, device_id } = req.body;

const key = license_key;

    const snapshot = await db.collection("licenses")
.where("license_key", "==", key)
.where("email", "==", email)
.limit(1)
.get();

if (snapshot.empty) {
  return res.status(404).json({
    success: false,
    message: "LICENSE TIDAK DITEMUKAN"
  });
}

const doc = snapshot.docs[0];
const data = doc.data();
const ref = doc.ref;

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

app.post("/api/payment-webhook", async (req, res) => {

  try {

    const data = req.body;

    console.log("WEBHOOK MASUK:");
    console.log(JSON.stringify(data, null, 2));

    if (
      data.event !== "payment.received" &&
      data.event !== "subscription.activated" &&
      data.event !== "subscription.renewed"
    ) {
      return res.json({
        success: true,
        ignored: true
      });
    }

    const email = data.data.customer.email;

    const ref = db.collection("licenses").doc(email);

    const doc = await ref.get();

    const now = new Date();

    const expired = new Date();
    expired.setMonth(expired.getMonth() + 1);

    let license_key = null;

    if (doc.exists) {

      const oldData = doc.data();

      license_key = oldData.license_key;

      await ref.update({
        expired_at: expired.toISOString(),
        active: true
      });

      console.log("USER LAMA DIPERPANJANG");

    } else {

      license_key =
        "NEXCO-" +
        crypto.randomBytes(4).toString("hex").toUpperCase();

      await ref.set({
        email,
        license_key,
        active: true,
        created_at: now.toISOString(),
        expired_at: expired.toISOString(),
        active_device_id: null
      });

      console.log("USER BARU DIBUATKAN KEY");
      console.log("KEY:", license_key);
    }

    const response = await resend.emails.send({
      from: "reang@nexcooo.com",
      to: email,
      subject: "License Key Nexco Workspace",
      html: `
        <h2>Selamat Datang di Nexco Workspace 🚀</h2>

        <p>Berikut license key anda:</p>

        <h1>${license_key}</h1>

        <p>Masa aktif sampai:</p>

        <b>${expired.toDateString()}</b>

        <br><br>

        <p>Simpan license ini baik-baik.</p>
      `
    });

    console.log("EMAIL TERKIRIM");
    console.log(response);

    return res.json({
      success: true
    });

  } catch (err) {

    console.log(err);

    return res.status(500).json({
      success: false
    });

  }

});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("API RUNNING");
});
// redeploy test