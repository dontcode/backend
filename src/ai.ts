import type { RequestOptions, Transport } from './http'
import type {
    AiAgentCallbacks,
    AiAgentOptions,
    AiAgentResponse,
    AiCallOptions,
    AiChatOptions,
    AiChatResponse,
    AiGenerateOptions,
    AiImageOptions,
    AiImageResponse,
    AiMessage,
    AiSpeakOptions,
    AiSpeakResponse,
    AiSpeechAudio,
    AiSpeechVoice,
    AiStreamCallbacks,
    AiToolCall,
    AiToolResult,
    AiTranscribeOptions,
    AiTranscribeResponse,
    AiUsage,
    AiVisionOptions,
} from './types'

const AI_BASE = '/api/v1/ai'

/** An answer takes longer to start than a database read: two minutes unless told otherwise. */
const AI_TIMEOUT_MS = 120_000

const ZERO: AiUsage = { inputTokens: 0, outputTokens: 0 }

function callOptions(options: AiCallOptions): RequestOptions {
    return { timeoutMs: options.timeoutMs ?? AI_TIMEOUT_MS }
}

/** The `data: {...}` events of a server-sent stream, `[DONE]` and junk lines skipped. */
async function* readEvents(response: Response): AsyncGenerator<Record<string, unknown>> {
    const reader = response.body?.getReader()
    if (!reader) return
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            const data = line.slice(6).trim()
            if (!data || data === '[DONE]') continue
            try {
                const parsed: unknown = JSON.parse(data)
                if (parsed && typeof parsed === 'object') yield parsed as Record<string, unknown>
            } catch {
                // A malformed line is skipped, as the Insight SDK does.
            }
        }
    }
}

function usageOf(value: unknown): AiUsage {
    const u = value as Partial<AiUsage> | undefined
    return {
        inputTokens: typeof u?.inputTokens === 'number' ? u.inputTokens : 0,
        outputTokens: typeof u?.outputTokens === 'number' ? u.outputTokens : 0,
    }
}

function asBlob(audio: AiSpeechAudio): Blob {
    if (audio instanceof Blob) return audio
    const bytes = audio instanceof Uint8Array ? audio : new Uint8Array(audio)
    // Copied into a plain ArrayBuffer so a view over a larger buffer sends only its own bytes.
    return new Blob([bytes.slice().buffer as ArrayBuffer])
}

/** Chat: text in, text out, whole or as it comes. */
export class AiChatApi {
    constructor(private readonly transport: Transport) {}

    /** The whole answer at once. */
    send(options: AiChatOptions): Promise<AiChatResponse> {
        return this.transport.json<AiChatResponse>(
            `${AI_BASE}/chat`,
            {
                intent: options.intent ?? 'balanced',
                messages: options.messages,
                maxTokens: options.maxTokens,
                system: options.system,
            },
            callOptions(options)
        )
    }

    /** The answer as it is written: `onToken` for each piece, the whole at the end. */
    async stream(
        options: AiChatOptions,
        callbacks: AiStreamCallbacks = {}
    ): Promise<AiChatResponse> {
        try {
            const res = await this.transport.raw(
                `${AI_BASE}/chat`,
                JSON.stringify({
                    intent: options.intent ?? 'balanced',
                    messages: options.messages,
                    maxTokens: options.maxTokens,
                    system: options.system,
                    stream: true,
                }),
                callOptions(options)
            )
            let content = ''
            let usage = ZERO
            for await (const event of readEvents(res)) {
                if (event.type === 'token' && typeof event.token === 'string') {
                    content += event.token
                    callbacks.onToken?.(event.token)
                } else if (event.type === 'done') {
                    usage = usageOf(event.usage)
                } else if (event.type === 'error') {
                    throw new Error(
                        typeof event.error === 'string' ? event.error : 'The answer stopped'
                    )
                }
            }
            const response = { content, usage }
            callbacks.onDone?.(response)
            return response
        } catch (err) {
            callbacks.onError?.(err as Error)
            throw err
        }
    }
}

/** Vision: an image (or several) in, text out. */
export class AiVisionApi {
    constructor(private readonly transport: Transport) {}

    analyze(options: AiVisionOptions): Promise<AiChatResponse> {
        return this.transport.json<AiChatResponse>(
            `${AI_BASE}/vision`,
            {
                intent: options.intent ?? 'balanced',
                prompt: options.prompt,
                images: options.images,
                system: options.system,
                maxTokens: options.maxTokens,
            },
            callOptions(options)
        )
    }
}

/** Image generation: text in, hosted image URLs out. */
export class AiImageApi {
    constructor(private readonly transport: Transport) {}

    generate(options: AiImageOptions): Promise<AiImageResponse> {
        return this.transport.json<AiImageResponse>(
            `${AI_BASE}/image`,
            {
                prompt: options.prompt,
                quality: options.quality ?? 'medium',
                size: options.size ?? '1024x1024',
                n: options.n ?? 1,
            },
            callOptions(options)
        )
    }
}

/** Speech: a recording in, what was said out; text in, the MP3 of it spoken out. */
export class AiSpeechApi {
    constructor(private readonly transport: Transport) {}

    /** Sent as multipart, never base64. At most 4 MB. */
    async transcribe(
        audio: AiSpeechAudio,
        options: AiTranscribeOptions = {}
    ): Promise<AiTranscribeResponse> {
        const form = new FormData()
        const blob = asBlob(audio)
        form.append('audio', blob, 'audio')
        if (options.language) form.append('language', options.language)
        const res = await this.transport.raw(
            `${AI_BASE}/speech/transcribe`,
            form,
            callOptions(options)
        )
        const body = (await res.json()) as Partial<AiTranscribeResponse>
        return {
            text: typeof body.text === 'string' ? body.text : '',
            language: typeof body.language === 'string' ? body.language : null,
            durationSeconds: typeof body.durationSeconds === 'number' ? body.durationSeconds : 0,
        }
    }

    /** At most 2,500 characters; split longer text at sentence ends. */
    async speak(text: string, options: AiSpeakOptions): Promise<AiSpeakResponse> {
        const res = await this.transport.raw(
            `${AI_BASE}/speech/speak`,
            JSON.stringify({ text, language: options.language, voice: options.voice }),
            callOptions(options)
        )
        const audio = new Uint8Array(await res.arrayBuffer())
        const characters = Number(res.headers.get('x-dontcode-characters'))
        return {
            audio,
            mediaType: 'audio/mpeg',
            characters: Number.isFinite(characters) ? characters : text.length,
            voice:
                (res.headers.get('x-dontcode-voice') as AiSpeechVoice | null) ??
                options.voice ??
                'woman-friendly',
        }
    }
}

/**
 * Agents: the model calls your tools in a loop. Each step is one model call at
 * DontCode; your server runs the tools it asks for (DontCode never sees their
 * code, only their schemas) and the loop goes on until a step calls none, or
 * `maxSteps` runs out.
 */
export class AiAgentApi {
    constructor(private readonly transport: Transport) {}

    private async step(
        options: AiAgentOptions,
        messages: AiMessage[],
        callbacks: AiAgentCallbacks
    ): Promise<{ text: string; toolCalls: AiToolCall[]; usage: AiUsage }> {
        const res = await this.transport.raw(
            `${AI_BASE}/agent`,
            JSON.stringify({
                intent: options.intent ?? 'balanced',
                messages,
                tools: options.tools.map((t) => ({
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters,
                })),
                system: options.system,
                maxTokens: options.maxTokens,
                stream: true,
            }),
            callOptions(options)
        )
        let text = ''
        const toolCalls: AiToolCall[] = []
        let usage = ZERO
        for await (const event of readEvents(res)) {
            if (event.type === 'token' && typeof event.token === 'string') {
                text += event.token
                callbacks.onToken?.(event.token)
            } else if (event.type === 'tool-call' && typeof event.toolName === 'string') {
                const call = {
                    toolCallId: String(event.toolCallId),
                    toolName: event.toolName,
                    input: event.input,
                }
                toolCalls.push(call)
                callbacks.onToolCall?.(call)
            } else if (event.type === 'done') {
                usage = usageOf(event.usage)
            } else if (event.type === 'error') {
                throw new Error(typeof event.error === 'string' ? event.error : 'The step stopped')
            }
        }
        return { text, toolCalls, usage }
    }

    async run(options: AiAgentOptions, callbacks: AiAgentCallbacks = {}): Promise<AiAgentResponse> {
        const tools = new Map(options.tools.map((t) => [t.name, t]))
        const messages: AiMessage[] = [...options.messages]
        const steps: AiAgentResponse['steps'] = []
        const total = { inputTokens: 0, outputTokens: 0 }
        const maxSteps = options.maxSteps ?? 5

        for (let step = 0; step < maxSteps; step++) {
            let result
            try {
                result = await this.step(options, messages, callbacks)
            } catch (err) {
                callbacks.onError?.(err as Error)
                return { text: '', messages, finishReason: 'error', usage: total, steps }
            }
            total.inputTokens += result.usage.inputTokens
            total.outputTokens += result.usage.outputTokens

            const toolResults: AiToolResult[] = []
            if (result.toolCalls.length > 0) {
                // The model's turn and the tools' answers, in the shapes the
                // service reads back (the same as @dontcode/ai sends).
                messages.push({
                    role: 'assistant',
                    content: [
                        ...(result.text ? [{ type: 'text' as const, text: result.text }] : []),
                        ...result.toolCalls.map((c) => ({ type: 'tool-call', ...c })),
                    ] as unknown as AiMessage['content'],
                })
                for (const call of result.toolCalls) {
                    const tool = tools.get(call.toolName)
                    let output: unknown
                    try {
                        output = tool ? await tool.execute(call.input) : { error: 'Unknown tool' }
                    } catch (err) {
                        output = { error: (err as Error).message }
                    }
                    const done = { toolCallId: call.toolCallId, toolName: call.toolName, output }
                    toolResults.push(done)
                    callbacks.onToolResult?.(done)
                    messages.push({
                        role: 'tool',
                        content: [
                            {
                                type: 'tool-result',
                                toolCallId: call.toolCallId,
                                toolName: call.toolName,
                                output: { type: 'json', value: output },
                            },
                        ] as unknown as AiMessage['content'],
                    })
                }
            } else if (result.text) {
                messages.push({ role: 'assistant', content: result.text })
            }

            steps.push({
                text: result.text,
                toolCalls: result.toolCalls,
                toolResults,
                usage: result.usage,
            })
            callbacks.onStepFinish?.({
                step,
                text: result.text,
                toolCalls: result.toolCalls,
                usage: result.usage,
            })

            if (result.toolCalls.length === 0) {
                return { text: result.text, messages, finishReason: 'stop', usage: total, steps }
            }
        }
        return {
            text: steps[steps.length - 1]?.text ?? '',
            messages,
            finishReason: 'max-steps',
            usage: total,
            steps,
        }
    }
}

/**
 * AI for your server, as an Insight app's server has it (@dontcode/ai): chat, vision, image
 * generation, speech and tool-using agents, included in the owner's plan up
 * to the app's daily AI limit, which the plan sets and which resets at
 * midnight Korean time. Past it a call fails with a 429 DontCodeError whose
 * code is `PAGE_AI_DAILY_LIMIT` (`err.quotaExceeded` is true): tell the
 * person the feature is back tomorrow rather than retrying. Server only: the
 * API key never reaches a browser, so a page calls your own route, which
 * checks who is asking first, so one person cannot use up everyone's day.
 */
export class AiApi {
    readonly chat: AiChatApi
    readonly vision: AiVisionApi
    readonly image: AiImageApi
    readonly speech: AiSpeechApi
    readonly agent: AiAgentApi

    constructor(transport: Transport) {
        this.chat = new AiChatApi(transport)
        this.vision = new AiVisionApi(transport)
        this.image = new AiImageApi(transport)
        this.speech = new AiSpeechApi(transport)
        this.agent = new AiAgentApi(transport)
    }

    /** One prompt in, the text out: the simplest call. */
    async generate(options: AiGenerateOptions): Promise<string> {
        const { content } = await this.chat.send({
            messages: [{ role: 'user', content: options.prompt }],
            intent: options.intent,
            maxTokens: options.maxTokens,
            system: options.system,
            timeoutMs: options.timeoutMs,
        })
        return content
    }
}

export function createAi(transport: Transport): AiApi {
    return new AiApi(transport)
}
