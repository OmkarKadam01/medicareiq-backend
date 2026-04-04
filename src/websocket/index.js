'use strict';

const { WebSocketServer, WebSocket } = require('ws');
const { URL } = require('url');
const { verifyAccessToken } = require('../services/authService');

/**
 * Per-clinic staff connections: clinicId (string) -> Set of { ws, key }
 * Allows O(staff_in_clinic) broadcast instead of O(all_clients).
 */
const clinicRooms = new Map();

/**
 * Per-patient connections: patientId (string) -> Set of { ws, key }
 */
const patientRooms = new Map();

/**
 * Full client map for lifecycle management (ping, cleanup).
 * Key: unique client key string
 * Value: { ws, identity: { type, id, role?, clinicId? } }
 */
const clients = new Map();

let clientIdCounter = 0;
let wss = null;

function buildMessage(event, payload) {
  return JSON.stringify({ event, payload, timestamp: new Date().toISOString() });
}

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
 * Broadcast an event to all staff connected to a specific clinic.
 * O(staff_in_clinic) — not O(all_clients).
 *
 * @param {number|string} clinicId
 * @param {string}        event
 * @param {Object}        payload
 */
function broadcastToClinic(clinicId, event, payload) {
  const message = buildMessage(event, payload);
  const room = clinicRooms.get(String(clinicId));
  if (!room || room.size === 0) {
    console.log(`[WS] broadcastToClinic(${clinicId}) '${event}' → 0 clients (empty room)`);
    return;
  }
  let count = 0;
  for (const { ws } of room) {
    safeSend(ws, message);
    count++;
  }
  console.log(`[WS] broadcastToClinic(${clinicId}) '${event}' → ${count} clients`);
}

/**
 * Broadcast an event to a specific patient's connected devices.
 *
 * @param {number|string} patientId
 * @param {string}        event
 * @param {Object}        payload
 */
function broadcastToPatient(patientId, event, payload) {
  const message = buildMessage(event, payload);
  const room = patientRooms.get(String(patientId));
  if (!room || room.size === 0) return;
  let count = 0;
  for (const { ws } of room) {
    safeSend(ws, message);
    count++;
  }
  console.log(`[WS] broadcastToPatient(${patientId}) '${event}' → ${count} connections`);
}

/**
 * Broadcast an event to ALL connected clients (admin use).
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
 * Register a client into the appropriate room.
 */
function joinRoom(clientKey, ws, identity) {
  if (identity.type === 'staff' && identity.clinicId) {
    const roomKey = String(identity.clinicId);
    if (!clinicRooms.has(roomKey)) clinicRooms.set(roomKey, new Set());
    clinicRooms.get(roomKey).add({ ws, key: clientKey });
  } else if (identity.type === 'patient') {
    const roomKey = String(identity.id);
    if (!patientRooms.has(roomKey)) patientRooms.set(roomKey, new Set());
    patientRooms.get(roomKey).add({ ws, key: clientKey });
  }
}

/**
 * Remove a client from its room on disconnect.
 */
function leaveRoom(clientKey, identity) {
  if (identity.type === 'staff' && identity.clinicId) {
    const room = clinicRooms.get(String(identity.clinicId));
    if (room) {
      for (const entry of room) {
        if (entry.key === clientKey) { room.delete(entry); break; }
      }
      if (room.size === 0) clinicRooms.delete(String(identity.clinicId));
    }
  } else if (identity.type === 'patient') {
    const room = patientRooms.get(String(identity.id));
    if (room) {
      for (const entry of room) {
        if (entry.key === clientKey) { room.delete(entry); break; }
      }
      if (room.size === 0) patientRooms.delete(String(identity.id));
    }
  }
}

async function handleConnection(ws, req) {
  let token;
  try {
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

  // Build identity — include clinicId for staff so room routing works
  const identity =
    decoded.type === 'staff'
      ? { type: 'staff', id: decoded.id, role: decoded.role, clinicId: decoded.clinicId ?? 1 }
      : { type: 'patient', id: decoded.id };

  const clientKey = `${identity.type}:${identity.id}:${++clientIdCounter}`;
  clients.set(clientKey, { ws, identity });
  joinRoom(clientKey, ws, identity);

  console.log(`[WS] Client connected: ${clientKey} (clinic:${identity.clinicId ?? 'n/a'}, total: ${clients.size})`);

  safeSend(ws, buildMessage('connection:ack', { clientKey, identity }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.event === 'ping') {
        safeSend(ws, buildMessage('pong', { time: Date.now() }));
      }
    } catch {
      console.warn(`[WS] Non-JSON message from ${clientKey}`);
    }
  });

  ws.on('close', (code) => {
    clients.delete(clientKey);
    leaveRoom(clientKey, identity);
    console.log(`[WS] Client disconnected: ${clientKey} (code: ${code}, remaining: ${clients.size})`);
  });

  ws.on('error', (err) => {
    console.error(`[WS] Error from ${clientKey}:`, err.message);
    clients.delete(clientKey);
    leaveRoom(clientKey, identity);
  });
}

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
        leaveRoom(key, client.identity);
        clients.delete(key);
        continue;
      }
      try {
        client.ws.ping();
      } catch {
        leaveRoom(key, client.identity);
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
