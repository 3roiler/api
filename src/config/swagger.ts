import swaggerJsdoc from 'swagger-jsdoc';
import type { OAS3Definition, OAS3Options } from 'swagger-jsdoc';
import config from './index.js';

const definition: OAS3Definition = {
  openapi: '3.1.0',
  info: {
    title: 'Broiler API',
    version: '1.0.0',
    description: 'API documentation for api.broiler.dev',
  },
  servers: [
    {
      url: `${config.apiBaseUrl}${config.apiPrefix}`,
    },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
      cookieAuth: {
        type: 'apiKey',
        in: 'cookie',
        name: config.jwt.cookieName ?? 'broiler_token',
      },
    },
    schemas: {
      HealthStatus: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['healthy', 'unhealthy'],
          },
          timestamp: {
            type: 'string',
            format: 'date-time',
          },
          service: {
            type: 'string',
          },
          database: {
            type: 'string',
          },
          uptime: {
            type: 'number',
            format: 'double',
          },
        },
        required: ['status', 'timestamp', 'service', 'database', 'uptime'],
      },
      User: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          githubId: { type: 'string', nullable: true },
          username: { type: 'string' },
          displayName: { type: 'string', nullable: true },
          email: { type: 'string', format: 'email', nullable: true },
          avatarUrl: { type: 'string', format: 'uri', nullable: true },
          profileUrl: { type: 'string', format: 'uri', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
        required: ['id', 'username', 'createdAt', 'updatedAt'],
      },
      UserCreateInput: {
        type: 'object',
        properties: {
          username: { type: 'string' },
          displayName: { type: 'string', nullable: true },
          email: { type: 'string', format: 'email', nullable: true },
          avatarUrl: { type: 'string', format: 'uri', nullable: true },
          profileUrl: { type: 'string', format: 'uri', nullable: true },
        },
        required: ['username'],
      },
      UserUpdateInput: {
        type: 'object',
        properties: {
          username: { type: 'string' },
          displayName: { type: 'string', nullable: true },
          email: { type: 'string', format: 'email', nullable: true },
          avatarUrl: { type: 'string', format: 'uri', nullable: true },
          profileUrl: { type: 'string', format: 'uri', nullable: true },
        },
        additionalProperties: false,
      },
    },
  },
};

const options: OAS3Options = {
  definition,
  apis: ['./src/routes/**/*.ts', './src/controllers/**/*.ts'],
};

const swaggerSpec = swaggerJsdoc(options);

export default swaggerSpec;
