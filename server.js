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

    console.log(req.body);

    const { email, license_key, device_id } = req.body;

    const snapshot = await db.collection("licenses")
      .where("license_key", "==", license_key)
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
      license_key: data.license_key
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      success: false,
      message: "SERVER ERROR",
    });

  }

});

const NEXCO_VARIANT_ID = "variant_HdaMLnpMdz9iJfFGEvRlJurm";

function getOrderLines(orderData) {
  return Array.isArray(orderData?.orderlines) ? orderData.orderlines : [];
}

function orderContainsNexco(orderData) {
  return getOrderLines(orderData).some(
    (line) => line?.variant_unique_id === NEXCO_VARIANT_ID
  );
}

function getPaymentEmail(paymentData, orderData) {
  const candidates = [
    paymentData?.customer?.email,
    paymentData?.destination_address?.email,
    orderData?.destination_address?.email,
    orderData?.customer?.email,
  ];
  return candidates.find((value) => typeof value === "string" && value.includes("@"))?.trim().toLowerCase() || null;
}

async function processMatchedPayment(orderId) {
  const orderRef = db.collection("scalev_orders").doc(orderId);
  const paymentRef = db.collection("scalev_payments").doc(orderId);
  const orderSnap = await orderRef.get();
  const paymentSnap = await paymentRef.get();

  if (!orderSnap.exists || !paymentSnap.exists) return { waiting: true };

  const orderData = orderSnap.data();
  const paymentData = paymentSnap.data();

  // Already ignored or fully completed payments must not be processed again.
  if (paymentData.processed === true && paymentData.ignored === true) return { ignored: true };
  if (paymentData.processed === true && paymentData.email_sent === true) return { duplicate: true };

  if (!orderContainsNexco(orderData)) {
    await paymentRef.set({
      processed: true,
      ignored: true,
      reason: "product_variant_not_nexco",
      processed_at: new Date().toISOString(),
    }, { merge: true });
    console.log("PEMBAYARAN DIABAIKAN: BUKAN VARIAN NEXCO", orderId);
    return { ignored: true };
  }

  const email = getPaymentEmail(paymentData, orderData);
  if (!email) {
    console.error("PEMBAYARAN NEXCO BELUM DIPROSES: EMAIL TIDAK DITEMUKAN", orderId);
    return { missingEmail: true };
  }

  const licenseRef = db.collection("licenses").doc(email);
  const now = new Date();
  let licenseKey;
  let expiryIso;
  let alreadyProcessed = false;

  await db.runTransaction(async (transaction) => {
    const freshPayment = await transaction.get(paymentRef);
    const freshPaymentData = freshPayment.exists ? freshPayment.data() : {};
    if (freshPaymentData.processed === true) {
      // License already granted. Reuse its stored details to retry a failed email
      // without extending the license a second time.
      alreadyProcessed = true;
      licenseKey = freshPaymentData.license_key || null;
      expiryIso = freshPaymentData.expired_at || null;
      return;
    }

    const licenseSnap = await transaction.get(licenseRef);
    const oldData = licenseSnap.exists ? licenseSnap.data() : null;
    licenseKey = oldData?.license_key || (
      "NEXCO-" + crypto.randomBytes(4).toString("hex").toUpperCase()
    );

    const oldExpiry = oldData?.expired_at ? new Date(oldData.expired_at) : null;
    const baseDate = oldExpiry && !Number.isNaN(oldExpiry.getTime()) && oldExpiry > now
      ? oldExpiry
      : now;
    const newExpiry = new Date(baseDate);
    newExpiry.setMonth(newExpiry.getMonth() + 1);
    expiryIso = newExpiry.toISOString();

    const licenseData = {
      email,
      license_key: licenseKey,
      active: true,
      expired_at: expiryIso,
      active_device_id: oldData?.active_device_id ?? null,
      updated_at: now.toISOString(),
    };
    if (!licenseSnap.exists) licenseData.created_at = now.toISOString();
    transaction.set(licenseRef, licenseData, { merge: true });
    transaction.set(paymentRef, {
      processed: true,
      ignored: false,
      email,
      license_key: licenseKey,
      expired_at: expiryIso,
      processed_at: now.toISOString(),
    }, { merge: true });
  });

  if (alreadyProcessed && (!licenseKey || !expiryIso)) {
    console.error("PEMBAYARAN SUDAH DITANDAI DIPROSES TAPI DATA LISENSI KURANG", orderId);
    return { dataError: true };
  }

  const refreshedPayment = await paymentRef.get();
  if (refreshedPayment.data()?.email_sent === true) return { duplicate: true };

  const response = await resend.emails.send({
    from: "reang@nexcooo.com",
    to: email,
    subject: "License Key Nexco Workspace",
    text: "Selamat Datang di Nexco Workspace\n\nLicense Key:\n" + licenseKey + "\n\nMasa aktif sampai:\n" + new Date(expiryIso).toDateString() + "\n\nSimpan license ini baik-baik.",
    html: "<h2>Selamat Datang di Nexco Workspace</h2><p>Berikut license key Anda:</p><h1>" + licenseKey + "</h1><p>Masa aktif sampai:</p><b>" + new Date(expiryIso).toDateString() + "</b><br><br><p>Simpan license ini baik-baik.</p>",
  });

  if (response?.error) {
    console.error("EMAIL LISENSI GAGAL", response.error);
    await paymentRef.set({ email_error: String(response.error.message || response.error) }, { merge: true });
    return { emailFailed: true };
  }

  await paymentRef.set({ email_sent: true, email_sent_at: new Date().toISOString() }, { merge: true });
  console.log("LICENSE DIPROSES DAN EMAIL TERKIRIM", orderId);
  return { success: true };
}

app.post("/api/payment-webhook", async (req, res) => {
  try {
    const event = req.body?.event;
    const data = req.body?.data;

    console.log("WEBHOOK MASUK:", event);

    if (!event || !data || typeof data !== "object" || !data.id) {
      console.warn("WEBHOOK DIABAIKAN: EVENT/PAYLOAD/ID TIDAK VALID");
      return res.status(400).json({ success: false, message: "Invalid webhook payload" });
    }

    if (event === "order.created" || event === "order.epayment_created" || event === "order.updated") {
      const orderRef = db.collection("scalev_orders").doc(String(data.id));
      const existingOrder = await orderRef.get();
      const incomingOrderLines = getOrderLines(data);
      const existingOrderData = existingOrder.exists ? existingOrder.data() : {};
      // Some order update payloads may omit orderlines. Never erase previously
      // captured product variants with an empty array.
      const orderLinesToStore = incomingOrderLines.length > 0
        ? incomingOrderLines
        : getOrderLines(existingOrderData);

      await orderRef.set({
        scalev_id: String(data.id),
        order_id: data.order_id || existingOrderData.order_id || null,
        orderlines: orderLinesToStore,
        destination_address: data.destination_address || existingOrderData.destination_address || null,
        customer: data.customer || existingOrderData.customer || null,
        last_event: event,
        last_event_unique_id: req.body?.unique_id || null,
        received_at: new Date().toISOString(),
      }, { merge: true });

      const pendingPayment = await db.collection("scalev_payments").doc(String(data.id)).get();
      if (pendingPayment.exists && ["paid", "settled"].includes(String(pendingPayment.data()?.payment_status || "").toLowerCase())) {
        const result = await processMatchedPayment(String(data.id));
        return res.json({ success: true, orderStored: true, paymentResult: result });
      }
      return res.json({ success: true, orderStored: true });
    }

    if (event === "payment.received") {
      const paymentStatus = String(data.payment_status || "").toLowerCase();
      if (!["paid", "settled"].includes(paymentStatus)) {
        return res.json({ success: true, ignored: true, reason: "payment_not_paid" });
      }

      const orderId = String(data.id);
      await db.collection("scalev_payments").doc(orderId).set({
        scalev_id: orderId,
        payment_status: paymentStatus,
        customer: data.customer || null,
        destination_address: data.destination_address || null,
        last_event: event,
        last_event_unique_id: req.body?.unique_id || null,
        received_at: new Date().toISOString(),
      }, { merge: true });

      const result = await processMatchedPayment(orderId);
      return res.json({ success: true, paymentStored: true, paymentResult: result });
    }

    // Fail closed until subscription events are mapped to a verified order and variant.
    if (event === "subscription.activated" || event === "subscription.renewed") {
      console.warn("SUBSCRIPTION EVENT BELUM DIPROSES: PERLU PEMETAAN PRODUK", event);
      return res.json({ success: true, ignored: true, reason: "subscription_product_not_verified" });
    }

    return res.json({ success: true, ignored: true, reason: "unsupported_event" });
  } catch (err) {
    console.error("WEBHOOK ERROR:", err);
    return res.status(500).json({ success: false });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("API RUNNING");
});
// redeploy test