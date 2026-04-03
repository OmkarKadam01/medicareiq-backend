'use strict';

const { WebSocketServer, WebSocket } = require('ws');
const { URL } = require('url');
const { verifyAccessToken } = require('../services/authService');

/**
 * Connected clients map.
 * Key: unique client key string
 * Value: { ws, identity: { type: 'patient'|'staff', id, role? } }
 */
const clients = new Map();

let clientIdCounter = 0;
let wss = null;

/**
 * Serialize a WebSocket message to JSON string.
 */
function buildMessage(event, payload) {
  return JSON.stringify({ event, payload, timestamp: new Date().toISOString() });
}

/**
 * Send a message to a single WebSocket connection, safely.
 */
function safeSend(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(message);
    } catch (err) {
      console.error('[WS] Failed to send message:', err.message);
    }
  }
}

/**
 * Broadcast an event to all connected clinic staff clients.
 * @param {string} event
 * @param {Object} payload
 */
function broadcastToClinic(event, payload) {
  const message = buildMessage(event, payload);
  let count = 0;
  for (const [, client] of clients) {
    if (client.identity.type === 'staff') {
      safeSend(client.ws, message);
      count++;
    }
  }
  console.log(`[WS] broadcastToClinic '${event}' → ${count} clinic clients`);
}

/**
 * Broadcast an event to a specific patient's connected devices.
 * @param {number|string} patientId
 * @param {string}        event
 * @param {Object}        payload
 */
function broadcastToPatient(patientId, event, payload) {
  const message = buildMessage(event, payload);
  const targetId = String(patientId);
  let count = 0;
  for (const [, client] of clients) {
    if (client.identity.type === 'patient' && String(client.identity.id) === targetId) {
      safeSend(client.ws, message);
      count++;
    }
  }
  console.log(`[WS] broadcastToPatient(${patientId}) '${event}' → ${count} connections`);
}

/**
 * Broadcast an event to ALL connected clients.
 * @param {string} event
 * @param {Object} payload
 */
function broadcastAll(event, payload) {
  const message = buildMessage(event, payload);
  let count = 0;
  for (const [, client] of clients) {
    safeSend(client.ws, message);
    count++;
  }
  console.log(`[WS] broadcastAll '${event}' → ${count} clients`);
}

/**
 * Authenticate and register a new WebSocket connection.
 * Expects JWT via query param: ws://host/ws?token=xxx
 *
 * On authentication failure, closes the connection with code 4001.
 *
 * @param {WebSocket} ws
 * @param {import('http').IncomingMessage} req
 */
async function handleConnection(ws, req) {
  let token;

  try {
    // Parse query params from the upgrade request URL
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    token = parsedUrl.searchParams.get('token');
  } catch {
    console.warn('[WS] Failed to parse upgrade URL');
    ws.close(4001, 'Invalid connection URL');
    return;
  }

  if (!token) {
    console.warn('[WS] Connection rejected: no token provided');
    ws.close(4001, 'Authentication required: provide ?token=<jwt>');
    return;
  }

  let decoded;
  try {
    decoded = await verifyAccessToken(token);
  } catch (err) {
    console.warn('[WS] Connection rejected: invalid token —', err.message);
    ws.close(4001, 'Authentication failed: ' + err.message);
    return;
  }

  // Build identity object
  const identity =
    decoded.type === 'staff'
      ? { type: 'staff', id: decoded.id, role: decoded.role }
      : { type: 'patient', id: decoded.id };

  const clientKey = `${identity.type}:${identity.id}:${++clientIdCounter}`;
  clients.set(clientKey, { ws, identity });

  console.log(`[WS] Client connected: ${clientKey} (total: ${clients.size})`);

  // Send welcome/ack
  safeSend(ws, buildMessage('connection:ack', { clientKey, identity }));

  // Handle incoming messages from the client
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      console.log(`[WS] Message from ${clientKey}:`, msg.event);

      // Handle ping/pong keepalive
      if (msg.event === 'ping') {
        safeSend(ws, buildMessage('pong', { time: Date.now() }));
      }
    } catch {
      console.warn(`[WS] Non-JSON message from ${clientKey}`);
    }
  });

  // Handle disconnection
  ws.on('close', (code, reason) => {
    clients.delete(clientKey);
    console.log(
      `[WS] Client disconnected: ${clientKey} (code: ${code}, remaining: ${clients.size})`
    );
  });

  ws.on('error', (err) => {
    console.error(`[WS] Error from ${clientKey}:`, err.message);
    clients.delete(clientKey);
  });
}

/**
 * Set up the WebSocket server attached to an existing HTTP server.
 * @param {import('http').Server} server
 */
function setupWebSocket(server) {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', handleConnection);

  wss.on('error', (err) => {
    console.error('[WS] Server error:', err.message);
  });

  // Heartbeat: ping all clients every 30 seconds to detect stale connections
  const heartbeatInterval = setInterval(() => {
    for (const [key, client] of clients) {
      if (client.ws.readyState !== WebSocket.OPEN) {
        clients.delete(key);
        continue;
      }
      try {
        client.ws.ping();
      } catch {
        clients.delete(key);
      }
    }
  }, 30000);

  wss.on('close', () => {
    clearInterval(heartbeatInterval);
  });

  console.log('[WS] WebSocket server initialized on path /ws');
  return wss;
}

/**
 * Get current connected client count (for monitoring).
 */
function getConnectedClientCount() {
  return clients.size;
}

module.exports = {
  setupWebSocket,
  broadcastToClinic,
  broadcastToPatient,
  broadcastAll,
  handleConnection,
  getConnectedClientCount,
};
