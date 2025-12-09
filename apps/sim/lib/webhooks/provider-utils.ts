import { createLogger } from '@/lib/logs/console/logger'

const logger = createLogger('ProviderUtils')

/**
 * Provider-specific unique identifier extractors for webhook idempotency
 */

/**
 * Extracts the unique event_id from Slack Events API payloads.
 * The event_id is globally unique and is the correct idempotency key for Slack.
 * Slack retries send the same event_id, so using this prevents duplicate processing.
 */
function extractSlackIdentifier(body: any): string | null {
  // Use event_id from Slack Events API - this is the only correct identifier
  // Slack includes event_id in all event_callback type payloads
  if (body.event_id) {
    logger.debug('Extracted Slack event_id for idempotency', {
      event_id: body.event_id,
      event_type: body.event?.type,
    })
    return body.event_id
  }

  // No event_id means this is not a standard event_callback payload
  // Log warning as this will cause duplicate processing issues
  logger.warn('No Slack event_id found for idempotency', {
    bodyType: body.type,
    bodyKeys: Object.keys(body || {}),
  })

  return null
}

function extractTwilioIdentifier(body: any): string | null {
  return body.MessageSid || body.CallSid || null
}

function extractStripeIdentifier(body: any): string | null {
  if (body.id && body.object === 'event') {
    return body.id
  }
  return null
}

function extractHubSpotIdentifier(body: any): string | null {
  if (Array.isArray(body) && body.length > 0 && body[0]?.eventId) {
    return String(body[0].eventId)
  }
  return null
}

function extractLinearIdentifier(body: any): string | null {
  if (body.action && body.data?.id) {
    return `${body.action}:${body.data.id}`
  }
  return null
}

function extractJiraIdentifier(body: any): string | null {
  if (body.webhookEvent && (body.issue?.id || body.project?.id)) {
    return `${body.webhookEvent}:${body.issue?.id || body.project?.id}`
  }
  return null
}

function extractMicrosoftTeamsIdentifier(body: any): string | null {
  if (body.value && Array.isArray(body.value) && body.value.length > 0) {
    const notification = body.value[0]
    if (notification.subscriptionId && notification.resourceData?.id) {
      return `${notification.subscriptionId}:${notification.resourceData.id}`
    }
  }
  return null
}

function extractAirtableIdentifier(body: any): string | null {
  if (body.cursor && typeof body.cursor === 'string') {
    return body.cursor
  }
  return null
}

const PROVIDER_EXTRACTORS: Record<string, (body: any) => string | null> = {
  slack: extractSlackIdentifier,
  twilio: extractTwilioIdentifier,
  twilio_voice: extractTwilioIdentifier,
  stripe: extractStripeIdentifier,
  hubspot: extractHubSpotIdentifier,
  linear: extractLinearIdentifier,
  jira: extractJiraIdentifier,
  'microsoft-teams': extractMicrosoftTeamsIdentifier,
  airtable: extractAirtableIdentifier,
}

export function extractProviderIdentifierFromBody(provider: string, body: any): string | null {
  if (!body || typeof body !== 'object') {
    return null
  }

  const extractor = PROVIDER_EXTRACTORS[provider]
  return extractor ? extractor(body) : null
}
