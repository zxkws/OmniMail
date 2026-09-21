import { applySuperAdminRole, sessionFromUser } from '../auth/session/auth'
import { sendMessage } from '../messages/send-message'
import { textToHtml } from '../../app/handlers/mail'
import { configuredSuperAdminEmail } from '../../app/super-admin'
import { deliverWithResend } from '../outbound/outbound-http-provider'
import { outboundProviderForAddress } from '../outbound/outbound-provider-config'
import type { Env, UserRow } from '../../app/types'

const INTERNAL_OPERATOR_HOST = 'omni-mail.internal'

type OperatorNotificationInput = {
  subject?: unknown
  text?: unknown
  idempotencyKey?: unknown
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

function validInput(input: OperatorNotificationInput): input is {
  subject: string
  text: string
  idempotencyKey: string
} {
  return typeof input.subject === 'string'
    && input.subject.trim().length >= 1
    && input.subject.trim().length <= 200
    && !/[\r\n]/u.test(input.subject)
    && typeof input.text === 'string'
    && input.text.trim().length >= 1
    && input.text.length <= 20_000
    && typeof input.idempotencyKey === 'string'
    && /^[a-zA-Z0-9_-]{8,100}$/u.test(input.idempotencyKey)
}

export async function handleOperatorNotification(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url)
  if (url.hostname !== INTERNAL_OPERATOR_HOST) return new Response('Not Found', { status: 404 })
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })

  const body = await request.json<OperatorNotificationInput>()
    .catch(() => ({} as OperatorNotificationInput))
  if (!validInput(body)) return json({ error: 'Invalid operator notification' }, 400)

  const operatorEmail = configuredSuperAdminEmail(env)
  if (!operatorEmail) return json({ error: 'Operator email is not configured' }, 503)

  const user = await env.DB.prepare(
    `SELECT id, email, display_name, role, status, mailbox_limit,
            storage_quota_bytes, storage_used_bytes,
            can_create_mailboxes, can_reply, can_translate,
            outbound_minute_limit, outbound_day_limit,
            temporary_expires_at, deleted_at, created_at
       FROM users
      WHERE email = ? AND status = 'active' AND deleted_at IS NULL
      LIMIT 1`,
  ).bind(operatorEmail).first<UserRow>()
  if (!user) return json({ error: 'Operator account is unavailable' }, 503)

  const mailbox = await env.DB.prepare(
    `SELECT address FROM mailboxes
      WHERE user_id = ? AND is_active = 1 AND is_hidden = 0
      ORDER BY is_primary DESC, created_at ASC
      LIMIT 1`,
  ).bind(user.id).first<{ address: string }>()
  if (!mailbox) return json({ error: 'Operator mailbox is unavailable' }, 503)

  const subject = body.subject.trim()
  const text = body.text.trim()
  if (outboundProviderForAddress(env, mailbox.address)) {
    return sendMessage(
      env,
      applySuperAdminRole(sessionFromUser(user), operatorEmail),
      {
        mailboxAddress: mailbox.address,
        to: operatorEmail,
        subject,
        text,
        idempotencyKey: body.idempotencyKey,
      },
      'service:internal',
    )
  }

  const legacyApiKey = env.RESEND_API_KEY?.trim()
  if (!legacyApiKey) return json({ error: 'Operator outbound provider is unavailable' }, 503)
  try {
    const providerId = await deliverWithResend(
      { provider: 'resend', apiKey: legacyApiKey },
      {
        from: env.RESEND_FROM?.trim() || mailbox.address,
        to: [operatorEmail],
        replyTo: mailbox.address,
        subject,
        text,
        html: textToHtml(text),
        idempotencyKey: body.idempotencyKey,
        headers: {},
        attachments: [],
      },
    )
    return json({ ok: true, providerId })
  } catch (error) {
    console.error('internal operator notification delivery failed', {
      type: error instanceof Error ? error.name : 'unknown',
    })
    return json({ error: 'Operator notification delivery failed' }, 502)
  }
}
