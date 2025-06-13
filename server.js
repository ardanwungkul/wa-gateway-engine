const express = require('express')
const { Client, LocalAuth } = require('whatsapp-web.js')
const qrcode = require('qrcode')
const fetch = require('node-fetch')
const http = require('http')
const { Server } = require('socket.io')
const cors = require('cors')
const fs = require('fs')
const path = require('path')
require('dotenv').config()
const config = require('./config')
const app = express()
const server = http.createServer(app)
const io = new Server(server, { cors: { origin: '*' } })

app.use(cors())
app.use(express.json())

const sessions = {}
const sessionDir = path.join(__dirname, '.wwebjs_auth')

async function loadSavedSessions() {
    if (!fs.existsSync(sessionDir)) return
    const folders = fs.readdirSync(sessionDir).filter((name) => name.startsWith('session-'))
    for (const folderName of folders) {
        const instanceId = folderName.replace(/^session-/, '')
        const sessionPath = path.join(sessionDir, folderName)

        console.log(`[${instanceId}] 🔄 Found saved session, marking as disconnected...`)

        try {
            if (fs.existsSync(sessionPath)) {
                fs.rmSync(sessionPath, { recursive: true, force: true })
                console.log(`[${instanceId}] 🧹 Session folder deleted`)
            }
        } catch (err) {
            console.error(`[${instanceId}] ❌ Failed to delete session folder:`, err.message)
        }

        try {
            await fetch(`${config.BACKEND_URL}/api/device/update-status`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    instance_id: instanceId,
                    status: 'disconnected',
                }),
            })
            console.log(`[${instanceId}] ✅ Laravel updated (disconnected)`)
        } catch (err) {
            console.error(`[${instanceId}] 🔴 Error updating Laravel:`, err.message)
        }
    }
}

function createClient(instanceId) {
    const client = new Client({
        authStrategy: new LocalAuth({ clientId: instanceId }),
        puppeteer: { headless: true },
    })

    client.on('qr', async (qr) => {
        if (sessions[instanceId].ready) return
        const qrImage = await qrcode.toDataURL(qr)
        io.emit(`qr-${instanceId}`, qrImage)
        console.log(`[${instanceId}] QR code emitted`)
    })

    client.on('ready', async () => {
        const waNumber = client.info.wid.user
        sessions[instanceId].ready = true

        io.emit(`ready-${instanceId}`, { status: 'connected', phone: waNumber })
        console.log(`[${instanceId}] Connected as ${waNumber}`)

        try {
            await fetch(`${config.BACKEND_URL}/api/device/update-status`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    instance_id: instanceId,
                    status: 'connected',
                    phone: waNumber,
                }),
            })
        } catch (err) {
            console.error(`[${instanceId}] Failed to update Laravel:`, err.message)
        }
    })

    client.on('disconnected', async (reason) => {
        console.log(`[${instanceId}] ❌ Disconnected: ${reason}`)
        sessions[instanceId].ready = false

        try {
            await client.destroy()
            console.log(`[${instanceId}] 🛑 Client destroyed`)
        } catch (err) {
            console.error(`[${instanceId}] ⚠️ Error destroying client:`, err.message)
        }

        const sessionPath = path.join(sessionDir, `session-${instanceId}`)
        try {
            if (fs.existsSync(sessionPath)) {
                fs.rmSync(sessionPath, { recursive: true, force: true })
                console.log(`[${instanceId}] 🧹 Session folder deleted`)
            }
        } catch (err) {
            console.error(`[${instanceId}] ❌ Failed to delete session folder:`, err.message)
        }

        try {
            await fetch(`${config.BACKEND_URL}/api/device/update-status`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    instance_id: instanceId,
                    status: 'disconnected',
                }),
            })
            console.log(`[${instanceId}] ✅ Laravel updated (disconnected)`)
        } catch (err) {
            console.error(`[${instanceId}] 🔴 Failed to update Laravel:`, err.message)
        }
    })

    client.on('message', async (msg) => {
        if (msg.body.toLowerCase() === 'hi') {
            await client.sendMessage(msg.from, 'Hai juga Sayangg! 👋')
        }
    })

    return client
}

// API Routes
app.post('/connect', (req, res) => {
    const { instance_id } = req.body

    if (sessions[instance_id]) {
        const s = sessions[instance_id]
        return res.json({ status: s.ready ? 'already_connected' : 'initializing' })
    }

    const client = createClient(instance_id)
    sessions[instance_id] = { client, ready: false }
    client.initialize()

    res.json({ status: 'initializing' })
})

app.post('/send-message', async (req, res) => {
    const { instance_id, number, message } = req.body
    const session = sessions[instance_id]

    if (!session || !session.ready) {
        return res.status(400).json({ status: 'error', message: 'Not connected' })
    }

    try {
        const chatId = number.includes('@c.us') ? number : `${number}@c.us`
        await session.client.sendMessage(chatId, message)
        res.json({ status: 'success', message: 'Message sent' })
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message })
    }
})

// Start Server
server.listen(5000, () => {
    console.log(`WA Engine listening on ${config.SERVER_URL}`)
    loadSavedSessions()
})
