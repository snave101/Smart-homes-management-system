import winston from 'winston';

export const transports = [
  new winston.transports.Console({
    level: process.env.LOGGER_LEVEL || 'debug',
    format: winston.format.combine(
      winston.format.timestamp({
        format: 'YYYY-MM-DDTHH:mm:ss.sss'
      }),
      winston.format.errors({ stack: true }),
      winston.format.printf((info) => {
        let message = info.message;
        if (info.stack) {
          message = `${info.message}${info.stack}`;
        }

        const line = `${info.timestamp} <${info.level.toUpperCase()[0]}> ${message}`;
        // hide the secret token of the payment callback urls
        return line.replace(/(\/c2b\/)[A-Za-z0-9]{16,}/g, '$1****');
      })
    )
  })
];

const logger = winston.createLogger({
  transports
});

export default logger;
