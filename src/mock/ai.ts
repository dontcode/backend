/**
 * The mock gateway's AI: answers in the shapes the live AI service gives, with
 * no model behind them and none of the app's daily AI used, so its AI features run
 * offline. Chat echoes what it was asked, so a page shows something that
 * changes with its input; a stream sends that answer a word at a time; an
 * agent step calls no tool; speech answers a fixed line and a quarter second
 * of silent MP3 (the Insight SDK's test-world answers).
 */

export type MockAiAnswer =
    | { kind: 'json'; status: number; body: unknown }
    | { kind: 'events'; events: unknown[] }
    | { kind: 'audio'; bytes: Uint8Array; headers: Record<string, string> }

const SILENT_FRAME_HEADER = [0xff, 0xfb, 0x10, 0xc4]
const SILENT_FRAME_BYTES = 104
const SILENT_FRAMES = 10

/** Ten silent MPEG-1 Layer III frames (44.1 kHz, mono, 32 kbps): valid, inaudible. */
function silentMp3(): Uint8Array {
    const mp3 = new Uint8Array(SILENT_FRAME_BYTES * SILENT_FRAMES)
    for (let i = 0; i < SILENT_FRAMES; i++) mp3.set(SILENT_FRAME_HEADER, i * SILENT_FRAME_BYTES)
    return mp3
}

const TRANSCRIPTS: Record<string, string> = {
    ko: '테스트 실행용 모의 받아쓰기입니다.',
    en: 'This is a mock transcript for a test run.',
    zh: '这是用于测试运行的模拟转写。',
    ja: 'これはテスト実行用の模擬文字起こしです。',
}

const VOICES = new Set(['woman-friendly', 'woman-clear', 'man-friendly', 'man-clear'])

function lastUserText(messages: unknown): string {
    if (!Array.isArray(messages)) return ''
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i] as { role?: unknown; content?: unknown }
        if (m?.role !== 'user') continue
        if (typeof m.content === 'string') return m.content
        if (Array.isArray(m.content)) {
            return m.content
                .map((part: { type?: unknown; text?: unknown }) =>
                    part?.type === 'text' && typeof part.text === 'string' ? part.text : ''
                )
                .join(' ')
        }
    }
    return ''
}

function mockAnswer(question: string): string {
    const asked = question.trim().slice(0, 200)
    return asked ? `Mock answer to: ${asked}` : 'Mock answer.'
}

const NO_USAGE = { inputTokens: 0, outputTokens: 0 }

export function answerAi(operation: string, raw: Buffer, contentType: string): MockAiAnswer {
    if (operation === 'speech/transcribe') {
        if (!contentType.startsWith('multipart/form-data')) {
            return { kind: 'json', status: 400, body: { error: 'audio is required' } }
        }
        const language = /name="language"\r\n\r\n([a-z]{2,3})\r\n/.exec(raw.toString('latin1'))?.[1]
        const spoken = language && TRANSCRIPTS[language] ? language : 'en'
        return {
            kind: 'json',
            status: 200,
            body: { text: TRANSCRIPTS[spoken], language: spoken, durationSeconds: 0 },
        }
    }

    let body: Record<string, unknown> = {}
    try {
        body = raw.length ? (JSON.parse(raw.toString('utf8')) as Record<string, unknown>) : {}
    } catch {
        return { kind: 'json', status: 400, body: { error: 'A JSON body is required' } }
    }

    switch (operation) {
        case 'chat': {
            if (!Array.isArray(body.messages)) {
                return { kind: 'json', status: 400, body: { error: 'messages is required' } }
            }
            const content = mockAnswer(lastUserText(body.messages))
            if (body.stream === true) {
                const words = content.split(/(?<= )/)
                return {
                    kind: 'events',
                    events: [
                        ...words.map((token) => ({ type: 'token', token })),
                        { type: 'done', usage: NO_USAGE },
                    ],
                }
            }
            return { kind: 'json', status: 200, body: { content, usage: NO_USAGE } }
        }
        case 'agent': {
            const content = mockAnswer(lastUserText(body.messages))
            return {
                kind: 'events',
                events: [
                    { type: 'token', token: content },
                    { type: 'done', finishReason: 'stop', usage: NO_USAGE },
                ],
            }
        }
        case 'vision': {
            const images = Array.isArray(body.images) ? body.images.length : 0
            return {
                kind: 'json',
                status: 200,
                body: { content: `Mock description of ${images} image(s).`, usage: NO_USAGE },
            }
        }
        case 'image':
            return {
                kind: 'json',
                status: 200,
                body: {
                    images: [],
                    model: 'mock',
                    quality: body.quality ?? 'medium',
                    size: body.size ?? '1024x1024',
                },
            }
        case 'speech/speak': {
            const text = typeof body.text === 'string' ? body.text.trim() : ''
            if (!text) return { kind: 'json', status: 400, body: { error: 'text is required' } }
            const voice =
                typeof body.voice === 'string' && VOICES.has(body.voice)
                    ? body.voice
                    : 'woman-friendly'
            return {
                kind: 'audio',
                bytes: silentMp3(),
                headers: {
                    'x-dontcode-characters': String(text.length),
                    'x-dontcode-voice': voice,
                },
            }
        }
        default:
            return { kind: 'json', status: 404, body: { error: 'Unknown AI operation' } }
    }
}
