const mailpitUrl = `http://${process.env.MAIL_HOST ?? 'mailpit'}:8025`;

interface MailpitAddress {
  Name: string;
  Address: string;
}

/** Fields of Mailpit's `GET /api/v1/messages` summaries used by the tests. */
export interface MailpitMessageSummary {
  ID: string;
  From: MailpitAddress;
  To: MailpitAddress[];
  Subject: string;
}

/** Fields of Mailpit's `GET /api/v1/message/{id}` used by the tests. */
export interface MailpitMessage extends MailpitMessageSummary {
  HTML: string;
  Text: string;
}

export async function getMailpitMessages(): Promise<MailpitMessageSummary[]> {
  const res = await fetch(`${mailpitUrl}/api/v1/messages`);
  const data = (await res.json()) as { messages?: MailpitMessageSummary[] };
  return data.messages ?? [];
}

export async function getMailpitMessage(id: string): Promise<MailpitMessage> {
  const res = await fetch(`${mailpitUrl}/api/v1/message/${id}`);
  return (await res.json()) as MailpitMessage;
}

export async function clearMailpitMessages(): Promise<void> {
  await fetch(`${mailpitUrl}/api/v1/messages`, { method: 'DELETE' });
}
