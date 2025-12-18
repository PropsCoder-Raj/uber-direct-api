/**
 * Uber Direct Integration (Single File)
 * -------------------------------------
 * Includes:
 * - getAccessToken
 * - getDeliveryQuotes
 * - createDelivery
 * - getDeliveryDetails
 * - cancelDelivery
 * - Delivery Status Webhook
 * - MongoDB (Mongoose)
 */

const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
require("dotenv").config();

// ====================== CONFIG ======================

const app = express();
app.use(bodyParser.json());

const PORT = 3000;

const UBER = {
    BASE_URL: 'https://api.uber.com',
    TOKEN_URL: 'https://login.uber.com/oauth/v2/token',
    CLIENT_ID: process.env.UBER_CLIENT_ID,
    CLIENT_SECRET: process.env.UBER_CLIENT_SECRET,
    CUSTOMER_ID: process.env.UBER_CUSTOMER_ID,
    SCOPE: 'eats.deliveries'
};

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/uber_direct';

// ====================== MONGODB ======================

mongoose.connect(MONGO_URI)
    .then(() => console.log('MongoDB Connected'))
    .catch(err => console.error(err));

// ====================== SCHEMA ======================

const DeliverySchema = new mongoose.Schema({
    externalId: String,
    quoteId: String,
    deliveryId: String,
    status: String,
    pickupAddress: String,
    dropoffAddress: String,
    fee: Number,
    raw: Object
}, { timestamps: true });

const Delivery = mongoose.model('Delivery', DeliverySchema);

const WebhookLogSchema = new mongoose.Schema({
    deliveryId: { type: String, index: true },
    eventType: String,
    status: String,
    payload: Object,
    receivedAt: { type: Date, default: Date.now }
});

const WebhookLog = mongoose.model('WebhookLog', WebhookLogSchema);


// ====================== TOKEN HANDLING ======================

let cachedToken = null;
let tokenExpiry = null;

async function getAccessToken() {
    if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

    const response = await axios.post(
        UBER.TOKEN_URL,
        new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: UBER.CLIENT_ID,
            client_secret: UBER.CLIENT_SECRET,
            scope: UBER.SCOPE
        }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    cachedToken = response.data.access_token;
    tokenExpiry = Date.now() + (response.data.expires_in - 60) * 1000;

    return cachedToken;
}

async function uberRequest(method, url, data = null) {
    const token = await getAccessToken();

    const response = await axios({
        method,
        url,
        data,
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
        }
    });

    return response.data;
}

// ====================== UBER APIs ======================

async function getDeliveryQuotes(payload) {
    return uberRequest(
        'POST',
        `${UBER.BASE_URL}/v1/customers/${UBER.CUSTOMER_ID}/delivery_quotes`,
        payload
    );
}

async function createDelivery(payload) {
    return uberRequest(
        'POST',
        `${UBER.BASE_URL}/v1/customers/${UBER.CUSTOMER_ID}/deliveries`,
        {
            ...payload,
            test_specifications: {
                robo_courier_specification: { mode: 'auto' }
            }
        }
    );
}

async function getDeliveryDetails(deliveryId) {
    return uberRequest(
        'GET',
        `${UBER.BASE_URL}/v1/customers/${UBER.CUSTOMER_ID}/deliveries/${deliveryId}`
    );
}

async function cancelDelivery(deliveryId) {
    return uberRequest(
        'POST',
        `${UBER.BASE_URL}/v1/customers/${UBER.CUSTOMER_ID}/deliveries/${deliveryId}/cancel`
    );
}

// ====================== EXPRESS APIs ======================

// 1️⃣ Get Quote
app.post('/quote', async (req, res) => {
    try {
        const quote = await getDeliveryQuotes(req.body);

        await Delivery.create({
            quoteId: quote.id,
            pickupAddress: req.body.pickup_address,
            dropoffAddress: req.body.dropoff_address,
            fee: quote.fee?.amount,
            raw: quote
        });

        res.json(quote);
    } catch (err) {
        res.status(400).json(err.response?.data || err.message);
    }
});

// 2️⃣ Create Delivery
app.post('/delivery', async (req, res) => {
    try {
        const delivery = await createDelivery(req.body);

        await Delivery.findOneAndUpdate(
            { quoteId: req.body.quote_id },
            {
                deliveryId: delivery.id,
                externalId: req.body.external_id,
                status: delivery.status,
                raw: delivery
            },
            { upsert: true }
        );

        res.json(delivery);
    } catch (err) {
        res.status(400).json(err.response?.data || err.message);
    }
});

// 3️⃣ Get Delivery Status
app.get('/delivery/:id', async (req, res) => {
    try {
        const data = await getDeliveryDetails(req.params.id);
        res.json(data);
    } catch (err) {
        res.status(400).json(err.response?.data || err.message);
    }
});

// 4️⃣ Cancel Delivery
app.post('/delivery/:id/cancel', async (req, res) => {
    try {
        const data = await cancelDelivery(req.params.id);
        res.json(data);
    } catch (err) {
        res.status(400).json(err.response?.data || err.message);
    }
});

// ====================== WEBHOOK ======================

/**
 * Uber Delivery Status Webhook
 * Configure this URL in Uber Dashboard
 */
app.post('/webhook/uber', async (req, res) => {
    const event = req.body;

    console.log('Webhook Received:', event);

    // 1️⃣ Store EVERY webhook event (audit log)
    await WebhookLog.create({
        deliveryId: event.delivery_id,
        eventType: event.event_type,
        status: event.status,
        payload: event
    });

    // 2️⃣ Update main delivery record (latest state)
    if (event.event_type === 'delivery.status_changed') {
        await Delivery.findOneAndUpdate(
            { deliveryId: event.delivery_id },
            {
                status: event.status,
                raw: event
            }
        );
    }

    res.sendStatus(200);
});

// ====================== SERVER ======================

app.listen(PORT, () => {
    console.log(`Uber Direct Server running on port ${PORT}`);
});
