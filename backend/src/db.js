'use strict';
const { Pool } = require('pg');

const db = new Pool({
    host:     process.env.DB_HOST     || 'db',
    port:     process.env.DB_PORT     || 5432,
    database: process.env.DB_NAME     || 'transcendence_db',
    user:     process.env.DB_USER     || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
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