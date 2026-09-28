import type { FastifyInstance } from 'fastify';
import { ApiError, errorBody } from './errors.js';

/** Content types accepted as raw image upload bodies (on the daemon and the node). */
export const IMAGE_CONTENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/octet-stream',
];

export function registerImageParsers(app: FastifyInstance, bodyLimit: number): void {
  for (const mime of IMAGE_CONTENT_TYPES)
    app.addContentTypeParser(mime, { parseAs: 'buffer', bodyLimit }, (_request, body, done) =>
      done(null, body),
    );
  // Generic file uploads can arrive with any declared type (or none); accept
  // whatever isn't already handled above as raw bytes so uploads aren't
  // limited to images. `text/plain` gets Fastify's own default (string)
  // parser, so it needs the same override explicitly.
  app.addContentTypeParser('text/plain', { parseAs: 'buffer', bodyLimit }, (_request, body, done) =>
    done(null, body),
  );
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit }, (_request, body, done) =>
    done(null, body),
  );
}

/** ApiError → its status and `{ error }` body; anything else is a logged 500. */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) return reply.status(error.statusCode).send(errorBody(error));
    if ((error as { code?: string }).code === 'FST_ERR_CTP_BODY_TOO_LARGE')
      return reply
        .status(413)
        .send(
          errorBody(
            new ApiError(413, 'payload_too_large', 'Request body exceeds configured limit'),
          ),
        );
    app.log.error(error);
    return reply
      .status(500)
      .send({ error: { code: 'internal_error', message: 'Internal server error' } });
  });
}
