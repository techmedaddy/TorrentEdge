const { Sequelize } = require('sequelize');
const winston = require('winston');
const path = require('path');

// Logger - reuse the one from server or create a dedicated DB logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: path.join(__dirname, '../../../logs/db_error.log'), level: 'error' }),
    new winston.transports.File({ filename: path.join(__dirname, '../../../logs/db.log') }),
  ],
});

const sequelize = new Sequelize(
  process.env.POSTGRES_DB || 'torrentedge',
  process.env.POSTGRES_USER || 'postgres',
  process.env.POSTGRES_PASSWORD || 'password',
  {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: process.env.POSTGRES_PORT || 5432,
    dialect: 'postgres',
    logging: (msg) => logger.debug(msg),
    pool: {
      max: 20,
      min: 0,
      acquire: 30000,
      idle: 10000
    },
    define: {
      underscored: true, // Use snake_case for fields in DB
      timestamps: true
    }
  }
);

const connectSQL = async () => {
  try {
    await sequelize.authenticate();
    console.log('[SQL] PostgreSQL connection has been established successfully.');
    
    // Sync models in development
    if (process.env.NODE_ENV !== 'production') {
      await sequelize.sync({ alter: true });
      console.log('[SQL] Database models synced.');
    }
  } catch (error) {
    console.error('[SQL] Unable to connect to the database:', error);
    process.exit(1);
  }
};

module.exports = { sequelize, connectSQL };
