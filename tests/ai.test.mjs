import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { dontcode, isDontCodeError } from '../dist/index.js'
import { startMockServer } from '../dist/mock/index.js'

/**
 * client.ai is @dontcode/ai's server API over /api/v1/ai. `fetch` is mocked
 * with real Response objects (streams and bytes included), so these pin the
 * wire shapes the gateway forwards and how the answers come back.
 */

let calls = []
let answers = []
const realFetch = globalThis.fetch

beforeEach(() => {
    calls = []
    answers = []
    globalThis.fetch = async (url, init) => {
        calls.push({ url, init })
        const next = answers.shift()
        return typeof next === 'function' ? next(init) : (next ?? json({}))
    }
})

afterEach(() => {
    globalThis.fetch = realFetch
})

const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const events = (...list) =>
    new Response(list.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' },
    })

const client = () => dontcode({ apiKey: 'dc_test' })
const bodyOf = (call) => JSON.parse(call.init.body)

describe('ai.chat and generate', () => {
    it('sends a chat with the balanced intent by default', async () => {
        answers.push(json({ content: '안녕하세요', usage: { inputTokens: 3, outputTokens: 2 } }))

        const answer = await client().ai.chat.send({
            messages: [{ role: 'user', content: '안녕' }],
        })

        assert.equal(calls[0].url, 'https://backend.dontcode.co/api/v1/ai/chat')
        assert.deepEqual(bodyOf(calls[0]), {
            intent: 'balanced',
            messages: [{ role: 'user', content: '안녕' }],
        })
        assert.equal(answer.content, '안녕하세요')
    })

    it('generate turns one prompt into one user message and answers the text', async () => {
        answers.push(json({ content: 'A tagline', usage: { inputTokens: 1, outputTokens: 1 } }))

        const text = await client().ai.generate({
            prompt: 'Write a tagline',
            intent: 'quick',
            system: 'Short.',
        })

        assert.equal(text, 'A tagline')
        assert.deepEqual(bodyOf(calls[0]), {
            intent: 'quick',
            messages: [{ role: 'user', content: 'Write a tagline' }],
            system: 'Short.',
        })
    })

    it('streams the answer token by token, then the whole with its usage', async () => {
        answers.push(
            events(
                { type: 'token', token: 'Hel' },
                { type: 'token', token: 'lo' },
                { type: 'done', usage: { inputTokens: 4, outputTokens: 2 } }
            )
        )
        const tokens = []
        let done

        const answer = await client().ai.chat.stream(
            { messages: [{ role: 'user', content: 'Hi' }] },
            { onToken: (t) => tokens.push(t), onDone: (r) => (done = r) }
        )

        assert.equal(bodyOf(calls[0]).stream, true)
        assert.deepEqual(tokens, ['Hel', 'lo'])
        assert.deepEqual(answer, { content: 'Hello', usage: { inputTokens: 4, outputTokens: 2 } })
        assert.deepEqual(done, answer)
    })

    it('stops a stream that reports an error, and says so', async () => {
        answers.push(
            events({ type: 'token', token: 'Hel' }, { type: 'error', error: 'overloaded' })
        )
        let seen

        await assert.rejects(
            () =>
                client().ai.chat.stream(
                    { messages: [{ role: 'user', content: 'Hi' }] },
                    { onError: (e) => (seen = e) }
                ),
            /overloaded/
        )
        assert.match(seen.message, /overloaded/)
    })

    it("fails with a 402 when the owner's credits are out", async () => {
        answers.push(json({ error: 'Insufficient credits', code: 'INSUFFICIENT_CREDITS' }, 402))

        await assert.rejects(
            () => client().ai.chat.send({ messages: [] }),
            (err) =>
                isDontCodeError(err) && err.status === 402 && err.code === 'INSUFFICIENT_CREDITS'
        )
    })

    it('fails a stream that is refused before it starts, with the same error', async () => {
        answers.push(json({ error: 'Insufficient credits' }, 402))

        await assert.rejects(
            () => client().ai.chat.stream({ messages: [] }),
            (err) => isDontCodeError(err) && err.status === 402
        )
    })

    it('gives up on a call that does not answer within its timeout', async () => {
        answers.push(
            (init) =>
                new Promise((_, reject) =>
                    init.signal.addEventListener('abort', () => reject(new Error('aborted')))
                )
        )

        const started = Date.now()
        await assert.rejects(
            () => client().ai.chat.send({ messages: [], timeoutMs: 20 }),
            (err) => isDontCodeError(err) && err.status === 408
        )
        assert.ok(Date.now() - started < 2000, 'the call took its own timeout, not the default')
    })
})

describe('ai.vision and ai.image', () => {
    it('sends the prompt and the images', async () => {
        answers.push(json({ content: 'A receipt', usage: { inputTokens: 1, outputTokens: 1 } }))

        await client().ai.vision.analyze({
            prompt: 'What is this?',
            images: ['https://x.example/a.png'],
        })

        assert.equal(calls[0].url, 'https://backend.dontcode.co/api/v1/ai/vision')
        assert.deepEqual(bodyOf(calls[0]), {
            intent: 'balanced',
            prompt: 'What is this?',
            images: ['https://x.example/a.png'],
        })
    })

    it('generates images with the defaults the Insight SDK uses', async () => {
        answers.push(
            json({ images: [{ url: 'https://cdn.example/i.png', mediaType: 'image/png' }] })
        )

        const result = await client().ai.image.generate({ prompt: 'A cat' })

        assert.deepEqual(bodyOf(calls[0]), {
            prompt: 'A cat',
            quality: 'medium',
            size: '1024x1024',
            n: 1,
        })
        assert.equal(result.images[0].url, 'https://cdn.example/i.png')
    })
})

describe('ai.speech', () => {
    it('sends a recording as multipart with its language, only its own bytes', async () => {
        answers.push(json({ text: '안녕하세요', language: 'ko', durationSeconds: 2 }))
        const buffer = new Uint8Array([9, 9, 1, 2, 3, 9])
        const view = buffer.subarray(2, 5)

        const result = await client().ai.speech.transcribe(view, { language: 'ko' })

        assert.equal(calls[0].url, 'https://backend.dontcode.co/api/v1/ai/speech/transcribe')
        const form = calls[0].init.body
        assert.ok(form instanceof FormData)
        assert.equal(form.get('language'), 'ko')
        assert.deepEqual(
            new Uint8Array(await form.get('audio').arrayBuffer()),
            new Uint8Array([1, 2, 3])
        )
        assert.equal(calls[0].init.headers['Content-Type'], undefined)
        assert.deepEqual(result, { text: '안녕하세요', language: 'ko', durationSeconds: 2 })
    })

    it('hands back the MP3 bytes with the characters and voice the service billed', async () => {
        const mp3 = new Uint8Array([0xff, 0xfb, 0x10, 0xc4])
        answers.push(
            new Response(mp3, {
                headers: {
                    'content-type': 'audio/mpeg',
                    'x-dontcode-characters': '5',
                    'x-dontcode-voice': 'man-clear',
                },
            })
        )

        const result = await client().ai.speech.speak('안녕하세요', {
            language: 'ko',
            voice: 'man-clear',
        })

        assert.deepEqual(bodyOf(calls[0]), {
            text: '안녕하세요',
            language: 'ko',
            voice: 'man-clear',
        })
        assert.deepEqual(result.audio, mp3)
        assert.equal(result.mediaType, 'audio/mpeg')
        assert.equal(result.characters, 5)
        assert.equal(result.voice, 'man-clear')
    })
})

describe('ai.agent.run', () => {
    const lookupOrder = {
        name: 'lookupOrder',
        description: 'Find an order',
        parameters: { type: 'object', properties: { id: { type: 'string' } } },
        execute: async ({ id }) => ({ id, status: 'shipped' }),
    }

    it('runs the tool the model asks for on your server, then lets the model answer', async () => {
        answers.push(
            events(
                {
                    type: 'tool-call',
                    toolCallId: 'c1',
                    toolName: 'lookupOrder',
                    input: { id: '42' },
                },
                {
                    type: 'done',
                    finishReason: 'tool-calls',
                    usage: { inputTokens: 10, outputTokens: 5 },
                }
            ),
            events(
                { type: 'token', token: 'Order 42 has shipped.' },
                { type: 'done', finishReason: 'stop', usage: { inputTokens: 20, outputTokens: 6 } }
            )
        )
        const results = []

        const run = await client().ai.agent.run(
            { messages: [{ role: 'user', content: 'Where is order 42?' }], tools: [lookupOrder] },
            { onToolResult: (r) => results.push(r) }
        )

        assert.equal(run.finishReason, 'stop')
        assert.equal(run.text, 'Order 42 has shipped.')
        assert.deepEqual(run.usage, { inputTokens: 30, outputTokens: 11 })
        assert.deepEqual(results, [
            { toolCallId: 'c1', toolName: 'lookupOrder', output: { id: '42', status: 'shipped' } },
        ])

        const first = bodyOf(calls[0])
        assert.deepEqual(first.tools, [
            {
                name: 'lookupOrder',
                description: 'Find an order',
                parameters: lookupOrder.parameters,
            },
        ])
        assert.equal(first.stream, true)
        const second = bodyOf(calls[1])
        assert.equal(second.messages.length, 3)
        assert.equal(second.messages[2].role, 'tool')
        assert.deepEqual(second.messages[2].content[0].output, {
            type: 'json',
            value: { id: '42', status: 'shipped' },
        })
    })

    it('stops at maxSteps, and answers an unknown tool with an error the model can read', async () => {
        const call = events(
            { type: 'tool-call', toolCallId: 'c', toolName: 'nope', input: {} },
            { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } }
        )
        answers.push(
            call,
            events(
                { type: 'tool-call', toolCallId: 'd', toolName: 'nope', input: {} },
                { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } }
            )
        )

        const run = await client().ai.agent.run({ messages: [], tools: [lookupOrder], maxSteps: 2 })

        assert.equal(run.finishReason, 'max-steps')
        assert.equal(calls.length, 2)
        assert.deepEqual(run.steps[0].toolResults[0].output, { error: 'Unknown tool' })
    })

    it('ends with error when a step is refused, keeping what came before', async () => {
        answers.push(json({ error: 'Insufficient credits' }, 402))
        let seen

        const run = await client().ai.agent.run(
            { messages: [{ role: 'user', content: 'hi' }], tools: [] },
            { onError: (e) => (seen = e) }
        )

        assert.equal(run.finishReason, 'error')
        assert.equal(seen.status, 402)
    })
})

describe('mock gateway: AI offline', () => {
    it('answers chat, streams, speech and agents in the live shapes, spending nothing', async () => {
        globalThis.fetch = realFetch
        const mock = await startMockServer({ dataDir: null, quiet: true, port: 0 })
        try {
            const c = dontcode({ baseUrl: mock.url, apiKey: 'dc_test' })

            const text = await c.ai.generate({ prompt: 'Name my cafe' })
            assert.equal(text, 'Mock answer to: Name my cafe')

            const tokens = []
            const streamed = await c.ai.chat.stream(
                { messages: [{ role: 'user', content: 'Say hi' }] },
                { onToken: (t) => tokens.push(t) }
            )
            assert.equal(streamed.content, 'Mock answer to: Say hi')
            assert.ok(tokens.length > 1)

            const spoken = await c.ai.speech.speak('Hello', { language: 'en' })
            assert.equal(spoken.audio.byteLength, 1040)
            assert.equal(spoken.characters, 5)

            const heard = await c.ai.speech.transcribe(new Uint8Array([1, 2, 3]), {
                language: 'ko',
            })
            assert.equal(heard.language, 'ko')

            const run = await c.ai.agent.run({
                messages: [{ role: 'user', content: 'Help' }],
                tools: [],
            })
            assert.equal(run.finishReason, 'stop')
            assert.equal(run.text, 'Mock answer to: Help')
        } finally {
            await mock.close()
        }
    })
})
