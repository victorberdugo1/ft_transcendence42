'use strict';
const { Pool } = require('pg');

const db = new Pool({
    host:     process.env.DB_HOST     || 'db',
    port:     process.env.DB_PORT     || 5432,
    database: process.env.DB_NAME     || 'transcendence_db',
    user:     process.env.DB_USER     || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    // Without these, `pg` waits forever by default. A hiccup acquiring a
    // connection or running a query (e.g. a first-boot DNS/network blip on a
    // freshly created Docker network) would hang an `await` indefinitely
    // instead of rejecting — and resolveMatchWinner's try/catch only catches
    // rejections, not hangs, so match_end would never get broadcast and the
    // client would be stuck on the game screen forever.
    connectionTimeoutMillis: 10000,
    query_timeout: 15000,
});

db.connect()
  .then(client => {
    console.log('[DB] Conectado a PostgreSQL');
    client.release();
  })
  .catch(err => console.error('[DB] Error de conexión:', err.message));

// Sin este listener, un error en un cliente inactivo del pool (p.ej. el
// contenedor de Postgres reiniciándose) se relanza como excepción no
// capturada y tumba todo el proceso, incluidas las partidas en curso.
db.on('error', (err) => {
    console.error('[DB] Error inesperado en cliente inactivo del pool:', err.message);
});

module.exports = db;