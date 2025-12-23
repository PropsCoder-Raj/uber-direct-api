/**
 * SINGLE FILE: Backend + Frontend (React CDN)
 * Run:
 *   npm init -y
 *   npm i express mongoose axios dotenv
 *   node server.js
 *
 * ENV:
 *   PORT=3000
 *   MONGO_URI=mongodb://127.0.0.1:27017/uber_direct
 *   UBER_CLIENT_ID=...
 *   UBER_CLIENT_SECRET=...
 *   UBER_CUSTOMER_ID=...
 */

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const mongoose = require("mongoose");

const app = express();
app.use(express.json({ limit: "2mb" }));

// ====================== CONFIG ======================

const PORT = process.env.PORT || 3000;

const UBER = {
    BASE_URL: "https://api.uber.com",
    TOKEN_URL: "https://login.uber.com/oauth/v2/token",
    CLIENT_ID: process.env.UBER_CLIENT_ID,
    CLIENT_SECRET: process.env.UBER_CLIENT_SECRET,
    CUSTOMER_ID: process.env.UBER_CUSTOMER_ID,
    SCOPE: "eats.deliveries",
};

const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/uber_direct";

// ====================== MONGODB ======================

mongoose
    .connect(MONGO_URI)
    .then(() => console.log("✅ MongoDB Connected:", MONGO_URI))
    .catch((err) => console.error("❌ MongoDB Error:", err.message));

// ====================== SCHEMAS ======================

const UserSchema = new mongoose.Schema(
    {
        user_type: { type: String, enum: ["CUSTOMER", "WAREHOUSE"], required: true, index: true },
        name: { type: String, required: true },
        address: { type: Object, required: true }, // store raw address object
        phone_number: { type: String, required: true, index: true, }, // Uber strongly recommends phone numbers
    },
    { timestamps: true }
);
const User = mongoose.model("User", UserSchema);

const ItemSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, index: true },
        price: { type: Number, required: true },
        qty: { type: Number, required: true, default: 0 },
    },
    { timestamps: true }
);
const Item = mongoose.model("Item", ItemSchema);

const QuoteSchema = new mongoose.Schema(
    {
        quoteId: { type: String, index: true }, // Uber quote id
        customerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        warehouseId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

        pickupAddress: { type: Object, required: true }, // warehouse snapshot
        dropoffAddress: { type: Object, required: true }, // customer snapshot

        items: [
            {
                itemId: { type: mongoose.Schema.Types.ObjectId, ref: "Item", required: true },
                name: String,
                price: Number,
                qty: Number,
                lineTotal: Number,
            },
        ],
        subtotal: Number,

        fee: Number,
        raw: Object,
        status: { type: String, default: "draft", index: true }, // draft|quoted
    },
    { timestamps: true }
);
const Quote = mongoose.model("Quote", QuoteSchema);

const DeliverySchema = new mongoose.Schema(
    {
        deliveryId: { type: String, index: true }, // Uber delivery id
        externalId: { type: String, index: true },
        quoteDbId: { type: mongoose.Schema.Types.ObjectId, ref: "Quote", required: true },
        quoteId: { type: String, index: true }, // Uber quote id
        status: { type: String, index: true },
        raw: Object,
    },
    { timestamps: true }
);
const Delivery = mongoose.model("Delivery", DeliverySchema);

const WebhookLogSchema = new mongoose.Schema({
    deliveryId: { type: String, index: true },
    eventType: String,
    status: String,
    payload: Object,
    receivedAt: { type: Date, default: Date.now },
});
const WebhookLog = mongoose.model("WebhookLog", WebhookLogSchema);

// ====================== UBER TOKEN HANDLING ======================

let cachedToken = null;
let tokenExpiry = null;

async function getAccessToken() {
    if (!UBER.CLIENT_ID || !UBER.CLIENT_SECRET) {
        throw new Error("Missing UBER_CLIENT_ID / UBER_CLIENT_SECRET in .env");
    }
    if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

    const response = await axios.post(
        UBER.TOKEN_URL,
        new URLSearchParams({
            grant_type: "client_credentials",
            client_id: UBER.CLIENT_ID,
            client_secret: UBER.CLIENT_SECRET,
            scope: UBER.SCOPE,
        }).toString(),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    cachedToken = response.data.access_token;
    tokenExpiry = Date.now() + (response.data.expires_in - 60) * 1000;

    return cachedToken;
}

async function uberRequest(method, url, data = null) {
    try {
        
        if (!UBER.CUSTOMER_ID) throw new Error("Missing UBER_CUSTOMER_ID in .env");
        const token = await getAccessToken();

        const response = await axios({
            method,
            url,
            data,
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
            },
        });

        return response.data;
    
    } catch (error) {
        console.log("🚀 ~ uberRequest ~ error:", error)
    }
}

async function getDeliveryQuotes(payload) {
    return uberRequest("POST", `${UBER.BASE_URL}/v1/customers/${UBER.CUSTOMER_ID}/delivery_quotes`, payload);
}

async function createDelivery(payload) {
    return uberRequest("POST", `${UBER.BASE_URL}/v1/customers/${UBER.CUSTOMER_ID}/deliveries`, {
        ...payload,
        test_specifications: {
            robo_courier_specification: { mode: "auto" },
        },
    });
}

async function getDeliveryDetails(deliveryId) {
    return uberRequest("GET", `${UBER.BASE_URL}/v1/customers/${UBER.CUSTOMER_ID}/deliveries/${deliveryId}`);
}

async function cancelDelivery(deliveryId) {
    return uberRequest("POST", `${UBER.BASE_URL}/v1/customers/${UBER.CUSTOMER_ID}/deliveries/${deliveryId}/cancel`);
}

// ====================== HELPERS ======================

function computeQuoteTotals(items) {
    let subtotal = 0;
    const normalized = items.map((it) => {
        const lineTotal = (Number(it.price) || 0) * (Number(it.qty) || 0);
        subtotal += lineTotal;
        return { ...it, lineTotal };
    });
    return { subtotal, items: normalized };
}

// ====================== API: USERS ======================

app.post("/api/users", async (req, res) => {
    try {
        const doc = await User.create(req.body);
        res.json(doc);
    } catch (e) {
        res.status(400).json({ message: e.message });
    }
});

app.get("/api/users", async (req, res) => {
    const q = {};
    if (req.query.user_type) q.user_type = req.query.user_type;
    const docs = await User.find(q).sort({ createdAt: -1 });
    res.json(docs);
});

app.get("/api/users/:id", async (req, res) => {
    const doc = await User.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: "User not found" });
    res.json(doc);
});

app.patch("/api/users/:id", async (req, res) => {
    try {
        const doc = await User.findByIdAndUpdate(req.params.id, req.body, { new: true });
        if (!doc) return res.status(404).json({ message: "User not found" });
        res.json(doc);
    } catch (e) {
        res.status(400).json({ message: e.message });
    }
});

app.delete("/api/users/:id", async (req, res) => {
    await User.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
});

// ====================== API: ITEMS ======================

app.post("/api/items", async (req, res) => {
    try {
        const doc = await Item.create(req.body);
        res.json(doc);
    } catch (e) {
        res.status(400).json({ message: e.message });
    }
});

app.get("/api/items", async (req, res) => {
    const docs = await Item.find({}).sort({ createdAt: -1 });
    res.json(docs);
});

app.get("/api/items/:id", async (req, res) => {
    const doc = await Item.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: "Item not found" });
    res.json(doc);
});

app.patch("/api/items/:id", async (req, res) => {
    try {
        const doc = await Item.findByIdAndUpdate(req.params.id, req.body, { new: true });
        if (!doc) return res.status(404).json({ message: "Item not found" });
        res.json(doc);
    } catch (e) {
        res.status(400).json({ message: e.message });
    }
});

app.delete("/api/items/:id", async (req, res) => {
    await Item.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
});

// ====================== API: QUOTES ======================

app.post("/api/quotes", async (req, res) => {
    try {
        const { customerId, warehouseId, items } = req.body;

        const customer = await User.findById(customerId);
        const warehouse = await User.findById(warehouseId);
        if (!customer || !warehouse) return res.status(400).json({ message: "Invalid customer/warehouse" });
        if (customer.user_type !== "CUSTOMER") return res.status(400).json({ message: "customerId must be CUSTOMER" });
        if (warehouse.user_type !== "WAREHOUSE") return res.status(400).json({ message: "warehouseId must be WAREHOUSE" });

        const itemIds = (items || []).map((i) => i.itemId);
        const dbItems = await Item.find({ _id: { $in: itemIds } });

        const mapped = (items || []).map((i) => {
            const found = dbItems.find((x) => String(x._id) === String(i.itemId));
            if (!found) throw new Error(`Item not found: ${i.itemId}`);
            return {
                itemId: found._id,
                name: found.name,
                price: found.price,
                qty: Number(i.qty) || 1,
            };
        });

        const totals = computeQuoteTotals(mapped);

        const doc = await Quote.create({
            customerId,
            warehouseId,
            pickupAddress: warehouse.address,
            dropoffAddress: customer.address,
            items: totals.items,
            subtotal: totals.subtotal,
            status: "draft",
        });

        res.json(doc);
    } catch (e) {
        res.status(400).json({ message: e.message });
    }
});

app.get("/api/quotes", async (req, res) => {
    const docs = await Quote.find({})
        .populate("customerId", "name user_type")
        .populate("warehouseId", "name user_type")
        .sort({ createdAt: -1 });
    res.json(docs);
});

app.get("/api/quotes/:id", async (req, res) => {
    const doc = await Quote.findById(req.params.id)
        .populate("customerId", "name user_type address")
        .populate("warehouseId", "name user_type address")
        .populate("items.itemId", "name price qty");
    if (!doc) return res.status(404).json({ message: "Quote not found" });
    res.json(doc);
});

app.patch("/api/quotes/:id", async (req, res) => {
    try {
        const doc = await Quote.findByIdAndUpdate(req.params.id, req.body, { new: true });
        if (!doc) return res.status(404).json({ message: "Quote not found" });
        res.json(doc);
    } catch (e) {
        res.status(400).json({ message: e.message });
    }
});

app.delete("/api/quotes/:id", async (req, res) => {
    await Quote.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
});

function addressObjectToString(addr) {
  if (!addr) return "";

  const d = addr || {};

  return [
    d.street,
    d.city,
    d.state,
    d.postal_code,
    d.country,
  ]
    .filter(Boolean)
    .join(", ");
}

function extractName(addr, fallbackName = "") {
  if (!addr) return fallbackName;
  if (typeof addr === "string") return fallbackName;
  return addr.name || fallbackName;
}

function extractPhone(addr, fallbackPhone = "") {
  if (!addr) return fallbackPhone;
  if (typeof addr === "string") return fallbackPhone;
  return addr.phone_number || fallbackPhone;
}

// Request Uber quote for a Quote document
app.post("/api/quotes/:id/request-uber-quote", async (req, res) => {
    try {
        const quoteDoc = await Quote.findById(req.params.id);
        console.log("🚀 ~ quoteDoc:", quoteDoc)
        if (!quoteDoc) return res.status(404).json({ message: "Quote not found" });

        const payload = {
            pickup_address: addressObjectToString(quoteDoc.pickupAddress),
            dropoff_address: addressObjectToString(quoteDoc.dropoffAddress),
        };
        console.log("🚀 ~ payload:", payload)

        const uberQuote = await getDeliveryQuotes(payload);
        console.log("🚀 ~ uberQuote:", uberQuote)

        quoteDoc.quoteId = uberQuote.id;
        quoteDoc.fee = uberQuote.fee?.amount;
        quoteDoc.raw = uberQuote;
        quoteDoc.status = "quoted";
        await quoteDoc.save();

        res.json(quoteDoc);
    } catch (e) {
        res.status(400).json(e.response?.data || { message: e.message });
    }
});

// ====================== API: DELIVERIES ======================

app.post("/api/deliveries/from-quote/:quoteDbId", async (req, res) => {
  try {
    const quoteDoc = await Quote.findById(req.params.quoteDbId);
    if (!quoteDoc) return res.status(404).json({ message: "Quote not found" });
    if (!quoteDoc.quoteId)
      return res.status(400).json({ message: "Quote has no Uber quoteId. Request Uber Quote first." });

    // Load customer + warehouse to ensure we have name/phone (optional but recommended)
    const customer = await User.findById(quoteDoc.customerId);
    const warehouse = await User.findById(quoteDoc.warehouseId);

    const external_id =
      req.body.external_id || `JOB_${String(quoteDoc._id).slice(-6)}_${Date.now()}`;

    const payload = {
      quote_id: quoteDoc.quoteId,

      pickup_address: addressObjectToString(quoteDoc.pickupAddress),
      pickup_name: extractName(quoteDoc.pickupAddress, warehouse?.name || "Warehouse"),
      pickup_phone_number: extractPhone(quoteDoc.pickupAddress, warehouse?.phone_number || "+14155552671"),

      dropoff_address: addressObjectToString(quoteDoc.dropoffAddress),
      dropoff_name: extractName(quoteDoc.dropoffAddress, customer?.name || "Customer"),
      dropoff_phone_number: extractPhone(quoteDoc.dropoffAddress, customer?.phone_number || "+14155552672"),

      manifest_items: (quoteDoc.items || []).map((it) => ({
        name: it.name,
        quantity: Number(it.qty) || 1,
        size: req.body.size || "medium",         // default, or compute by rules
        price: Number(it.price) || 0,
      })),

      external_id,
    };

    // Basic validation (avoid Uber rejecting)
    if (!payload.pickup_address || !payload.dropoff_address) {
      return res.status(400).json({ message: "Missing pickup/dropoff address" });
    }
    if (!payload.pickup_phone_number || !payload.dropoff_phone_number) {
      // if Uber allows empty phone you can remove this check
      console.warn("⚠️ Missing phone numbers in payload");
    }

    const delivery = await createDelivery(payload);

    const doc = await Delivery.create({
      quoteDbId: quoteDoc._id,
      quoteId: quoteDoc.quoteId,
      externalId: external_id,
      deliveryId: delivery.id,
      status: delivery.status,
      raw: delivery,
    });

    res.json({ delivery: doc, uber_payload_sent: payload });
  } catch (e) {
    res.status(400).json(e.response?.data || { message: e.message });
  }
});


app.get("/api/deliveries", async (req, res) => {
    const docs = await Delivery.find({}).populate("quoteDbId").sort({ createdAt: -1 });
    res.json(docs);
});

app.get("/api/deliveries/:id", async (req, res) => {
    const doc = await Delivery.findById(req.params.id).populate("quoteDbId");
    if (!doc) return res.status(404).json({ message: "Delivery not found" });
    res.json(doc);
});

app.post("/api/deliveries/:id/refresh", async (req, res) => {
    try {
        const doc = await Delivery.findById(req.params.id);
        if (!doc) return res.status(404).json({ message: "Delivery not found" });

        const data = await getDeliveryDetails(doc.deliveryId);
        doc.status = data.status;
        doc.raw = data;
        await doc.save();

        res.json(doc);
    } catch (e) {
        res.status(400).json(e.response?.data || { message: e.message });
    }
});

app.post("/api/deliveries/:id/cancel", async (req, res) => {
    try {
        const doc = await Delivery.findById(req.params.id);
        if (!doc) return res.status(404).json({ message: "Delivery not found" });

        const canceled = await cancelDelivery(doc.deliveryId);
        doc.status = canceled.status || "canceled";
        doc.raw = canceled;
        await doc.save();

        res.json(doc);
    } catch (e) {
        res.status(400).json(e.response?.data || { message: e.message });
    }
});

app.delete("/api/deliveries/:id", async (req, res) => {
    await Delivery.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
});

// ====================== WEBHOOK ======================

app.post("/webhook/uber", async (req, res) => {
    const event = req.body;

    console.log("📩 Webhook Received:", event?.event_type, event?.delivery_id, event?.status);

    await WebhookLog.create({
        deliveryId: event.delivery_id,
        eventType: event.event_type,
        status: event.status,
        payload: event,
    });

    if (event.event_type === "delivery.status_changed") {
        await Delivery.findOneAndUpdate(
            { deliveryId: event.delivery_id },
            { status: event.status, raw: event }
        );
    }

    res.sendStatus(200);
});

// ====================== FRONTEND: SINGLE PAGE (React CDN) ======================

app.get("/", (req, res) => {
    res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Uber Direct Admin (Single File)</title>
  <script src="https://cdn.tailwindcss.com"></script>

  <!-- React CDN -->
  <script crossorigin src="https://unpkg.com/react@18/umd/react.development.js"></script>
  <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>

  <!-- Babel (so we can write JSX in one file) -->
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
</head>
<body class="bg-slate-50 text-slate-900">
  <div id="root"></div>

<script type="text/babel">
const { useEffect, useMemo, useState } = React;

const api = {
  async get(path) {
    const r = await fetch(path);
    const j = await r.json();
    if (!r.ok) throw new Error(j.message || "Request failed");
    return j;
  },
  async post(path, body) {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type":"application/json" }, body: JSON.stringify(body || {}) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.message || "Request failed");
    return j;
  },
  async patch(path, body) {
    const r = await fetch(path, { method: "PATCH", headers: { "Content-Type":"application/json" }, body: JSON.stringify(body || {}) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.message || "Request failed");
    return j;
  },
  async del(path) {
    const r = await fetch(path, { method: "DELETE" });
    const j = await r.json();
    if (!r.ok) throw new Error(j.message || "Request failed");
    return j;
  }
};

function Card({title, subtitle, right, children}) {
  return (
    <div className="bg-white border rounded-xl shadow-sm">
      <div className="p-4 border-b flex items-center justify-between gap-4">
        <div>
          <div className="text-lg font-semibold">{title}</div>
          {subtitle ? <div className="text-sm text-slate-500">{subtitle}</div> : null}
        </div>
        <div>{right}</div>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function Btn({children, onClick, variant="default", disabled}) {
  const base = "px-3 py-2 rounded-lg text-sm font-medium border transition";
  const styles = {
    default: "bg-slate-900 text-white border-slate-900 hover:bg-slate-800",
    outline: "bg-white text-slate-900 border-slate-200 hover:bg-slate-50",
    danger: "bg-red-600 text-white border-red-600 hover:bg-red-500",
    ghost: "bg-transparent text-slate-900 border-transparent hover:bg-slate-100"
  };
  return (
    <button disabled={disabled} onClick={onClick} className={base + " " + styles[variant] + (disabled ? " opacity-60 cursor-not-allowed" : "")}>
      {children}
    </button>
  );
}

function Input({label, value, onChange, placeholder, type="text"}) {
  return (
    <label className="block">
      {label ? <div className="text-xs font-medium text-slate-600 mb-1">{label}</div> : null}
      <input type={type} value={value} placeholder={placeholder} onChange={e=>onChange(e.target.value)}
        className="w-full px-3 py-2 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-slate-300 bg-white" />
    </label>
  );
}

function Select({label, value, onChange, options}) {
  return (
    <label className="block">
      {label ? <div className="text-xs font-medium text-slate-600 mb-1">{label}</div> : null}
      <select value={value} onChange={e=>onChange(e.target.value)}
        className="w-full px-3 py-2 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-slate-300 bg-white">
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

function Toast({msg, onClose}) {
  if (!msg) return null;
  return (
    <div className="fixed bottom-4 right-4 bg-slate-900 text-white px-4 py-3 rounded-xl shadow-lg flex items-center gap-3">
      <div className="text-sm">{msg}</div>
      <button onClick={onClose} className="text-xs underline opacity-80">close</button>
    </div>
  );
}

function UsersPage({toast}) {
  const [rows, setRows] = useState([]);
  const [filter, setFilter] = useState("ALL");
  const [loading, setLoading] = useState(false);

  const [form, setForm] = useState({
    user_type: "CUSTOMER",
    name: "",
    address: { street: "", city: "", state: "", postal_code: "", country: "" }
  });

  async function load() {
    setLoading(true);
    try {
      const q = filter === "ALL" ? "" : "?user_type=" + filter;
      const data = await api.get("/api/users" + q);
      setRows(data);
    } catch(e) { toast("❌ " + e.message); }
    finally { setLoading(false); }
  }

  useEffect(()=>{ load(); }, [filter]);

  async function create() {
    try {
      await api.post("/api/users", form);
      toast("✅ User created");
      setForm({ user_type: "CUSTOMER", name:"", address:{street:"",city:"",state:"",postal_code:"",country:""} });
      load();
    } catch(e) { toast("❌ " + e.message); }
  }

  async function remove(id) {
    if (!confirm("Delete this user?")) return;
    try {
      await api.del("/api/users/" + id);
      toast("✅ User deleted");
      load();
    } catch(e) { toast("❌ " + e.message); }
  }

  return (
    <div className="space-y-4">
      <Card
        title="Users"
        subtitle="Customers + Warehouses"
        right={
          <div className="flex gap-2 items-end">
            <Select
              label="Filter"
              value={filter}
              onChange={setFilter}
              options={[
                { value:"ALL", label:"All" },
                { value:"CUSTOMER", label:"Customer" },
                { value:"WAREHOUSE", label:"Warehouse" },
              ]}
            />
            <Btn variant="outline" onClick={load} disabled={loading}>{loading ? "Loading..." : "Refresh"}</Btn>
          </div>
        }
      >
        <div className="grid md:grid-cols-2 gap-4">
          <div className="border rounded-xl p-3 bg-slate-50">
            <div className="font-semibold mb-3">Create User</div>
            <div className="grid grid-cols-2 gap-3">
              <Select
                label="Type"
                value={form.user_type}
                onChange={(v)=>setForm(p=>({...p, user_type:v}))}
                options={[
                  { value:"CUSTOMER", label:"CUSTOMER" },
                  { value:"WAREHOUSE", label:"WAREHOUSE" },
                ]}
              />
              <Input label="Name" value={form.name} onChange={(v)=>setForm(p=>({...p, name:v}))} placeholder="John / Main WH" />
              <Input label="Street" value={form.address.street} onChange={(v)=>setForm(p=>({...p, address:{...p.address, street:v}}))} />
              <Input label="City" value={form.address.city} onChange={(v)=>setForm(p=>({...p, address:{...p.address, city:v}}))} />
              <Input label="State" value={form.address.state} onChange={(v)=>setForm(p=>({...p, address:{...p.address, state:v}}))} />
              <Input label="Postal" value={form.address.postal_code} onChange={(v)=>setForm(p=>({...p, address:{...p.address, postal_code:v}}))} />
              <Input label="Country" value={form.address.country} onChange={(v)=>setForm(p=>({...p, address:{...p.address, country:v}}))} placeholder="IN / US / SA" />
              <Input label="Phone Number" placeholder="+14155552671" value={form.phone_number} onChange={(v) => setForm((p) => ({ ...p, phone_number: v }))} />
            </div>
            <div className="mt-3">
              <Btn onClick={create}>Create</Btn>
            </div>
            <div className="text-xs text-slate-500 mt-2">
              Address is stored as raw object. Use Uber-compatible format if needed later.
            </div>
          </div>

          <div className="border rounded-xl overflow-hidden">
            <div className="grid grid-cols-5 gap-2 p-3 bg-white border-b text-xs font-semibold text-slate-600">
              <div>Type</div><div>Name</div><div>City</div><div>Created</div><div className="text-right">Action</div>
            </div>
            <div className="max-h-[420px] overflow-auto bg-white">
              {rows.map(r=>(
                <div key={r._id} className="grid grid-cols-5 gap-2 p-3 border-b text-sm items-center">
                  <div className="text-xs font-semibold">{r.user_type}</div>
                  <div className="truncate">{r.name}</div>
                  <div className="text-slate-600">{r.address?.city || "-"}</div>
                  <div className="text-xs text-slate-500">{new Date(r.createdAt).toLocaleString()}</div>
                  <div className="text-right">
                    <Btn variant="danger" onClick={()=>remove(r._id)}>Delete</Btn>
                  </div>
                </div>
              ))}
              {!rows.length ? <div className="p-3 text-sm text-slate-500">No users found</div> : null}
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

function ItemsPage({toast}) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({ name:"", price:0, qty:0 });

  async function load() {
    setLoading(true);
    try {
      setRows(await api.get("/api/items"));
    } catch(e){ toast("❌ " + e.message); }
    finally { setLoading(false); }
  }
  useEffect(()=>{ load(); }, []);

  async function create() {
    try {
      await api.post("/api/items", { ...form, price:Number(form.price), qty:Number(form.qty) });
      toast("✅ Item created");
      setForm({ name:"", price:0, qty:0 });
      load();
    } catch(e){ toast("❌ " + e.message); }
  }
  async function remove(id) {
    if (!confirm("Delete this item?")) return;
    try {
      await api.del("/api/items/" + id);
      toast("✅ Item deleted");
      load();
    } catch(e){ toast("❌ " + e.message); }
  }

  return (
    <div className="space-y-4">
      <Card title="Items" subtitle="Manage products" right={<Btn variant="outline" onClick={load} disabled={loading}>{loading?"Loading...":"Refresh"}</Btn>}>
        <div className="grid md:grid-cols-2 gap-4">
          <div className="border rounded-xl p-3 bg-slate-50">
            <div className="font-semibold mb-3">Create Item</div>
            <div className="grid grid-cols-2 gap-3">
              <Input label="Name" value={form.name} onChange={(v)=>setForm(p=>({...p, name:v}))} placeholder="Engine Oil" />
              <Input label="Price" type="number" value={form.price} onChange={(v)=>setForm(p=>({...p, price:v}))} />
              <Input label="Qty" type="number" value={form.qty} onChange={(v)=>setForm(p=>({...p, qty:v}))} />
            </div>
            <div className="mt-3"><Btn onClick={create}>Create</Btn></div>
          </div>

          <div className="border rounded-xl overflow-hidden bg-white">
            <div className="grid grid-cols-5 gap-2 p-3 border-b text-xs font-semibold text-slate-600">
              <div>Name</div><div>Price</div><div>Qty</div><div>Created</div><div className="text-right">Action</div>
            </div>
            <div className="max-h-[420px] overflow-auto">
              {rows.map(r=>(
                <div key={r._id} className="grid grid-cols-5 gap-2 p-3 border-b text-sm items-center">
                  <div className="truncate">{r.name}</div>
                  <div>₹{Number(r.price).toFixed(2)}</div>
                  <div>{r.qty}</div>
                  <div className="text-xs text-slate-500">{new Date(r.createdAt).toLocaleString()}</div>
                  <div className="text-right">
                    <Btn variant="danger" onClick={()=>remove(r._id)}>Delete</Btn>
                  </div>
                </div>
              ))}
              {!rows.length ? <div className="p-3 text-sm text-slate-500">No items found</div> : null}
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

function QuotesPage({toast}) {
  const [users, setUsers] = useState([]);
  const [items, setItems] = useState([]);
  const [quotes, setQuotes] = useState([]);
  const [loading, setLoading] = useState(false);

  const customers = useMemo(()=>users.filter(u=>u.user_type==="CUSTOMER"), [users]);
  const warehouses = useMemo(()=>users.filter(u=>u.user_type==="WAREHOUSE"), [users]);

  const [form, setForm] = useState({
    customerId: "",
    warehouseId: "",
    lines: [{ itemId:"", qty:1 }],
  });

  async function bootstrap() {
    setLoading(true);
    try {
      const [u, it, q] = await Promise.all([
        api.get("/api/users"),
        api.get("/api/items"),
        api.get("/api/quotes"),
      ]);
      setUsers(u);
      setItems(it);
      setQuotes(q);
      if (!form.customerId && customers.length) {}
    } catch(e){ toast("❌ " + e.message); }
    finally { setLoading(false); }
  }

  useEffect(()=>{ bootstrap(); }, []);

  function addLine() {
    setForm(p=>({...p, lines:[...p.lines, { itemId:"", qty:1 }]}));
  }
  function removeLine(idx) {
    setForm(p=>({...p, lines:p.lines.filter((_,i)=>i!==idx)}));
  }

  async function createQuote() {
    try {
      if (!form.customerId || !form.warehouseId) throw new Error("Select customer and warehouse");
      const lines = form.lines.filter(l=>l.itemId && Number(l.qty) > 0);
      if (!lines.length) throw new Error("Add at least one item");
      const payload = {
        customerId: form.customerId,
        warehouseId: form.warehouseId,
        items: lines.map(l=>({ itemId: l.itemId, qty: Number(l.qty) })),
      };
      await api.post("/api/quotes", payload);
      toast("✅ Quote created");
      setForm({ customerId:"", warehouseId:"", lines:[{ itemId:"", qty:1 }] });
      setQuotes(await api.get("/api/quotes"));
    } catch(e){ toast("❌ " + e.message); }
  }

  async function requestUberQuote(id) {
    try {
      const updated = await api.post("/api/quotes/" + id + "/request-uber-quote", {});
      toast("✅ Uber quote received (fee: " + (updated.fee ?? "-") + ")");
      setQuotes(await api.get("/api/quotes"));
    } catch(e){ toast("❌ " + e.message); }
  }

  async function removeQuote(id) {
    if (!confirm("Delete this quote?")) return;
    try {
      await api.del("/api/quotes/" + id);
      toast("✅ Quote deleted");
      setQuotes(await api.get("/api/quotes"));
    } catch(e){ toast("❌ " + e.message); }
  }

  return (
    <div className="space-y-4">
      <Card title="Quotes" subtitle="Create quote → Request Uber Quote"
        right={<Btn variant="outline" onClick={bootstrap} disabled={loading}>{loading?"Loading...":"Refresh"}</Btn>}
      >
        <div className="grid md:grid-cols-2 gap-4">
          <div className="border rounded-xl p-3 bg-slate-50">
            <div className="font-semibold mb-3">Create Quote (Draft)</div>

            <div className="grid grid-cols-2 gap-3">
              <Select
                label="Customer"
                value={form.customerId}
                onChange={(v)=>setForm(p=>({...p, customerId:v}))}
                options={[{value:"", label:"Select..."}].concat(customers.map(u=>({value:u._id, label:u.name})))}
              />
              <Select
                label="Warehouse"
                value={form.warehouseId}
                onChange={(v)=>setForm(p=>({...p, warehouseId:v}))}
                options={[{value:"", label:"Select..."}].concat(warehouses.map(u=>({value:u._id, label:u.name})))}
              />
            </div>

            <div className="mt-3">
              <div className="text-sm font-semibold mb-2">Items</div>
              <div className="space-y-2">
                {form.lines.map((l, idx)=>(
                  <div key={idx} className="grid grid-cols-12 gap-2 items-end">
                    <div className="col-span-8">
                      <Select
                        label={idx===0 ? "Item" : ""}
                        value={l.itemId}
                        onChange={(v)=>setForm(p=>({
                          ...p,
                          lines: p.lines.map((x,i)=> i===idx ? {...x, itemId:v} : x)
                        }))}
                        options={[{value:"", label:"Select..."}].concat(items.map(it=>({value:it._id, label: it.name + " (₹" + it.price + ")"})))}
                      />
                    </div>
                    <div className="col-span-3">
                      <Input
                        label={idx===0 ? "Qty" : ""}
                        type="number"
                        value={l.qty}
                        onChange={(v)=>setForm(p=>({
                          ...p,
                          lines: p.lines.map((x,i)=> i===idx ? {...x, qty:v} : x)
                        }))}
                      />
                    </div>
                    <div className="col-span-1">
                      <Btn variant="ghost" onClick={()=>removeLine(idx)} disabled={form.lines.length===1}>✕</Btn>
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-2 flex gap-2">
                <Btn variant="outline" onClick={addLine}>+ Add item</Btn>
                <Btn onClick={createQuote}>Create Quote</Btn>
              </div>

              <div className="text-xs text-slate-500 mt-2">
                After creating, click “Request Uber Quote” to fetch fee + quoteId from Uber.
              </div>
            </div>
          </div>

          <div className="border rounded-xl overflow-hidden bg-white">
            <div className="grid grid-cols-7 gap-2 p-3 border-b text-xs font-semibold text-slate-600">
              <div>Status</div><div>Customer</div><div>Warehouse</div><div>Subtotal</div><div>Fee</div><div>QuoteId</div><div className="text-right">Actions</div>
            </div>
            <div className="max-h-[520px] overflow-auto">
              {quotes.map(q=>(
                <div key={q._id} className="grid grid-cols-7 gap-2 p-3 border-b text-sm items-center">
                  <div className="text-xs font-semibold">{q.status}</div>
                  <div className="truncate">{q.customerId?.name || "-"}</div>
                  <div className="truncate">{q.warehouseId?.name || "-"}</div>
                  <div>₹{Number(q.subtotal||0).toFixed(2)}</div>
                  <div>{q.fee != null ? q.fee : "-"}</div>
                  <div className="truncate text-xs text-slate-600">{q.quoteId || "-"}</div>
                  <div className="flex flex-wrap gap-2 justify-end">
                    <Btn
                        variant="outline"
                        onClick={() => requestUberQuote(q._id)}
                        disabled={q.status === "quoted"}
                    >
                        Request Uber Quote
                    </Btn>

                    <Btn
                        variant="danger"
                        onClick={() => removeQuote(q._id)}
                    >
                        Delete
                    </Btn>
                  </div>
                </div>
              ))}
              {!quotes.length ? <div className="p-3 text-sm text-slate-500">No quotes found</div> : null}
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

function DeliveriesPage({toast}) {
  const [quotes, setQuotes] = useState([]);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);

  const [selectedQuoteId, setSelectedQuoteId] = useState("");
  const [externalId, setExternalId] = useState("");

  async function load() {
    setLoading(true);
    try {
      const [q, d] = await Promise.all([
        api.get("/api/quotes"),
        api.get("/api/deliveries"),
      ]);
      setQuotes(q);
      setRows(d);
    } catch(e){ toast("❌ " + e.message); }
    finally { setLoading(false); }
  }
  useEffect(()=>{ load(); }, []);

  const quotedQuotes = useMemo(()=>quotes.filter(q=>q.status==="quoted" && q.quoteId), [quotes]);

  async function createFromQuote() {
    try {
      if (!selectedQuoteId) throw new Error("Select a quoted quote");
      const doc = await api.post("/api/deliveries/from-quote/" + selectedQuoteId, { external_id: externalId || undefined });
      toast("✅ Delivery created: " + doc.deliveryId);
      setExternalId("");
      setSelectedQuoteId("");
      load();
    } catch(e){ toast("❌ " + e.message); }
  }

  async function refresh(id) {
    try {
      await api.post("/api/deliveries/" + id + "/refresh", {});
      toast("✅ Refreshed");
      load();
    } catch(e){ toast("❌ " + e.message); }
  }

  async function cancel(id) {
    if (!confirm("Cancel this delivery on Uber?")) return;
    try {
      await api.post("/api/deliveries/" + id + "/cancel", {});
      toast("✅ Cancel requested");
      load();
    } catch(e){ toast("❌ " + e.message); }
  }

  async function remove(id) {
    if (!confirm("Delete this delivery record (DB only)?")) return;
    try {
      await api.del("/api/deliveries/" + id);
      toast("✅ Deleted");
      load();
    } catch(e){ toast("❌ " + e.message); }
  }

  return (
    <div className="space-y-4">
      <Card title="Deliveries" subtitle="Create delivery from a quoted quote"
        right={<Btn variant="outline" onClick={load} disabled={loading}>{loading?"Loading...":"Refresh"}</Btn>}
      >
        <div className="grid md:grid-cols-2 gap-4">
          <div className="border rounded-xl p-3 bg-slate-50">
            <div className="font-semibold mb-3">Create Delivery</div>
            <Select
              label="Select Quoted Quote"
              value={selectedQuoteId}
              onChange={setSelectedQuoteId}
              options={[{value:"", label:"Select..."}].concat(
                quotedQuotes.map(q=>({
                  value: q._id,
                  label: (q.customerId?.name || "Customer") + " → " + (q.warehouseId?.name || "Warehouse") + " | fee: " + (q.fee ?? "-")
                }))
              )}
            />
            <div className="mt-3">
              <Input label="External ID (optional)" value={externalId} onChange={setExternalId} placeholder="order_12345" />
            </div>
            <div className="mt-3">
              <Btn onClick={createFromQuote}>Create Delivery</Btn>
            </div>
            <div className="text-xs text-slate-500 mt-2">
              Delivery will be created using Uber quote_id stored in Quote.
            </div>
          </div>

          <div className="border rounded-xl overflow-hidden bg-white">
            <div className="grid grid-cols-6 gap-2 p-3 border-b text-xs font-semibold text-slate-600">
              <div>Status</div><div>DeliveryId</div><div>ExternalId</div><div>Quote</div><div>Created</div><div className="text-right">Actions</div>
            </div>
            <div className="max-h-[520px] overflow-auto">
              {rows.map(d=>(
                <div key={d._id} className="grid grid-cols-6 gap-2 p-3 border-b text-sm items-center">
                  <div className="text-xs font-semibold">{d.status || "-"}</div>
                  <div className="truncate text-xs">{d.deliveryId || "-"}</div>
                  <div className="truncate">{d.externalId || "-"}</div>
                  <div className="truncate text-xs text-slate-600">{d.quoteId || "-"}</div>
                  <div className="text-xs text-slate-500">{new Date(d.createdAt).toLocaleString()}</div>
                  <div className="text-right flex gap-2 justify-end">
                    <Btn variant="outline" onClick={()=>refresh(d._id)}>Refresh</Btn>
                    <Btn variant="outline" onClick={()=>cancel(d._id)}>Cancel</Btn>
                    <Btn variant="danger" onClick={()=>remove(d._id)}>Delete</Btn>
                  </div>
                </div>
              ))}
              {!rows.length ? <div className="p-3 text-sm text-slate-500">No deliveries found</div> : null}
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

function App() {
  const [tab, setTab] = useState("users");
  const [toastMsg, setToastMsg] = useState("");

  function toast(m) {
    setToastMsg(m);
    setTimeout(()=>setToastMsg(""), 2500);
  }

  const tabs = [
    { key:"users", label:"Users" },
    { key:"items", label:"Items" },
    { key:"quotes", label:"Quotes" },
    { key:"deliveries", label:"Deliveries" },
  ];

  return (
    <div className="min-h-screen">
      <div className="border-b bg-white">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between gap-4">
          <div>
            <div className="text-xl font-bold">Uber Direct Admin</div>
            <div className="text-sm text-slate-500">Single file (Express + Mongo + React CDN)</div>
          </div>
          <div className="flex gap-2">
            {tabs.map(t=>(
              <button
                key={t.key}
                onClick={()=>setTab(t.key)}
                className={
                  "px-3 py-2 rounded-lg text-sm font-medium " +
                  (tab===t.key ? "bg-slate-900 text-white" : "bg-slate-100 hover:bg-slate-200")
                }
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="max-w-10xl mx-auto p-4 space-y-4">
        {tab==="users" ? <UsersPage toast={toast} /> : null}
        {tab==="items" ? <ItemsPage toast={toast} /> : null}
        {tab==="quotes" ? <QuotesPage toast={toast} /> : null}
        {tab==="deliveries" ? <DeliveriesPage toast={toast} /> : null}

        <div className="text-xs text-slate-500">
          API base: <span className="font-mono">/api/*</span> | Webhook: <span className="font-mono">/webhook/uber</span>
        </div>
      </div>

      <Toast msg={toastMsg} onClose={()=>setToastMsg("")} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
</script>
</body>
</html>`);
});

// ====================== SERVER ======================

app.listen(PORT, () => {
    console.log("✅ Server running:", "http://localhost:" + PORT);
});
