/**
 * Image input for CodeBuddy sessions (ticket T6): the limits the composer
 * stages images under (the `images` capability), and the base64 image blocks
 * a user message carries after its text — the SDK's `ImageContentBlock`
 * source shape (`{type:'base64', media_type, data}` with PURE base64, no
 * `data:` prefix, codebuddy-sdk notes §2.3).
 *
 * Limits: the media types are exactly the SDK's `ImageMediaType` union
 * (`image/jpeg | image/png | image/gif | image/webp`). The CodeBuddy service
 * publishes no vision byte/dimension caps this bundle could cite, so the
 * envelope below mirrors the claude backend's (notes: 5 MiB per image after
 * the composer's downsample path, 20 images / 20 MiB per message, resampled
 * to 2000 px per side / 4 MP) — a conservative envelope the CLI/model scales
 * under anyway, and one the composer can plan against deterministically.
 *
 * Validation mirrors claudeImageBlocks: every staged image is read back and
 * checked against the limits once more (a limit change, a foreign facade) —
 * a violation throws a user-facing localized sentence, never a message
 * silently missing an image.
 */

/** What a CodeBuddy message may carry (see the module comment). */
export const CODEBUDDY_IMAGE_LIMITS = Object.freeze({
  mediaTypes: Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
  maxImageBytes: 5 * 1024 * 1024,
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 20 * 1024 * 1024,
  maxImageDimension: 2000,
  maxImagePixels: 4_000_000,
})

/** One base64 image block as the stream-json user content takes it. */
export function isAcceptedMediaType(mediaType, limits = CODEBUDDY_IMAGE_LIMITS) {
  return typeof mediaType === 'string' && (limits.mediaTypes).includes(mediaType)
}

const mb = bytes => Math.round(bytes / (1024 * 1024))

/**
 * The image blocks of one message, in order. Throws an Error whose message
 * is the localized user-facing refusal — submit() turns it into
 * `{accepted:false, reason}`.
 *
 * @param images  readonly TranscriptImage facades (AgentInput.images)
 * @param limits  the capability limits (defaults to CODEBUDDY_IMAGE_LIMITS)
 * @param text    bilingual dict accessor `(key, params) => string`
 */
export async function codebuddyImageBlocks(images, limits = CODEBUDDY_IMAGE_LIMITS, text) {
  if (images.length > limits.maxImagesPerMessage) {
    throw new Error(text('images-too-many', { count: limits.maxImagesPerMessage }))
  }
  const blocks = []
  let total = 0
  for (const image of images) {
    const label = typeof image?.name === 'string' && image.name !== '' ? image.name : String(image?.id ?? '?')
    if (!isAcceptedMediaType(image?.mediaType, limits)) {
      throw new Error(text('image-type-refused', { name: label, type: String(image?.mediaType ?? '?') }))
    }
    let data
    try {
      data = await image.read()
    } catch (error) {
      throw new Error(text('image-unreadable', { name: label, detail: String(error?.message ?? error) }))
    }
    if (!(data instanceof Uint8Array) || data.byteLength === 0) {
      throw new Error(text('image-unreadable', { name: label, detail: 'empty bytes' }))
    }
    if (data.byteLength > limits.maxImageBytes) {
      throw new Error(text('image-too-large', { name: label, mb: mb(limits.maxImageBytes) }))
    }
    total += data.byteLength
    if (total > limits.maxMessageImageBytes) {
      throw new Error(text('images-too-large', { mb: mb(limits.maxMessageImageBytes) }))
    }
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: image.mediaType, data: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64') },
    })
  }
  return blocks
}
