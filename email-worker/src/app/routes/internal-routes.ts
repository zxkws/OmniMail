import type { Hono } from 'hono'
import type { AppContext } from '../context'
import { handleOperatorNotification } from '../../features/notifications/operator-notification'

export function registerInternalRoutes(app: Hono<AppContext>): void {
  app.post('/api/internal/operator-notification', (context) => (
    handleOperatorNotification(context.env, context.req.raw)
  ))
}
