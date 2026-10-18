import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';

const MAILPIT_URL = `http://${process.env.MAIL_HOST ?? 'mailpit'}:8025`;
const PASSWORD = 'password123';

let userCounter = 0;

/** Polls Mailpit for the confirmation email sent to `email` and extracts its token. */
async function fetchConfirmationToken(email: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const search = await fetch(
      `${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`,
    );
    const { messages } = (await search.json()) as {
      messages: { ID: string }[];
    };
    if (messages.length > 0) {
      const message = await fetch(
        `${MAILPIT_URL}/api/v1/message/${messages[0].ID}`,
      );
      const { HTML } = (await message.json()) as { HTML: string };
      const token = /confirm-email\?token=([^"&\s]+)/.exec(HTML)?.[1];
      if (token) return token;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`No confirmation email found for ${email}`);
}

/** Signup → confirmation token from Mailpit → confirm → login; returns the access token. */
export async function registerConfirmAndLogin(
  app: INestApplication<App>,
): Promise<string> {
  const email = `e2e_${Date.now()}_${++userCounter}@example.com`;
  await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password: PASSWORD })
    .expect(201);
  const token = await fetchConfirmationToken(email);
  await request(app.getHttpServer())
    .get('/auth/confirm-email')
    .query({ token })
    .expect(204);
  const login = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password: PASSWORD })
    .expect(200);
  return (login.body as { access_token: string }).access_token;
}
