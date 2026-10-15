import fetch from 'node-fetch'
import yts from 'yt-search'
import fs from 'fs'
import path from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'
import { getBuffer } from '#serialize'

const execAsync = promisify(exec)
const tmpDir = './tmp'
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true })
const max_video_size = 40 * 1024 * 1024
const TIMEOUT_MS = 10 * 60 * 1000 // 10 MIN

async function getSpotifyLink(text) {
  try {
    const evoUrl = global.APIs?.evogb?.url
    const evoKey = global.APIs?.evogb?.key
    const endpoint = `${evoUrl}/search/spotify?query=${encodeURIComponent(text)}&key=${encodeURIComponent(evoKey)}`
    const res = await fetch(endpoint).then(r => r.json())
    if (res?.status && res.result?.[0]) return res.result[0]
  } catch {}
  return null
}
async function getYtLink(text) { try { const r = await yts(text); return r?.videos?.[0] || null } catch { return null } }
async function getMedia(type, url) {
  try {
    const evoUrl = global.APIs?.evogb?.url; const evoKey = global.APIs?.evogb?.key
    let p = 'ytmp3'; if (type === 'ytvideo') p = 'ytmp4'; if (type === 'spotify') p = 'spotify'
    const endpoint = `${evoUrl}/dl/${p}?url=${encodeURIComponent(url)}&key=${encodeURIComponent(evoKey)}`
    const res = await fetch(endpoint).then(r => r.json()); const d = res?.data || res?.result || res
    return d?.url || d?.dl || d?.download || null
  } catch { return null }
}
async function getFareVideo(url, quality = '360p') {
  const evogbUrl = global.APIs?.evogb?.url; const evogbKey = global.APIs?.evogb?.key
  const deliriusUrl = global.APIs?.delirius?.url || 'https://delirius-apiofc.vercel.app'
  const endpoints = [
    `${evogbUrl}/dl/ytv?url=${encodeURIComponent(url)}&quality=${quality}&key=${evogbKey}`,
    `${evogbUrl}/dl/ytmp4?url=${encodeURIComponent(url)}&quality=${quality}&key=${evogbKey}`,
    `${deliriusUrl}/download/ytmp4?url=${encodeURIComponent(url)}`
  ]
  for (const endpoint of endpoints) {
    try {
      const res = await fetch(endpoint, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' } })
      if (!res.ok) continue
      const json = JSON.parse(await res.text())
      const d = json?.data || json?.result || json
      const videoUrl = d?.dl || d?.download || d?.url
      if (!videoUrl) continue
      return { titulo: d.title || 'video', descarga: { url: videoUrl } }
    } catch {}
  }
  throw new Error('No se pudo obtener video')
}
async function downloadFile(url, dest) {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } })
  if (!res.ok) throw new Error(`Download failed ${res.status}`)
  const fileStream = fs.createWriteStream(dest)
  if (typeof res.body.pipe === 'function') await pipeline(res.body, fileStream)
  else await pipeline(Readable.fromWeb(res.body), fileStream)
}
function sanitizeFileName(name = 'video') { return String(name).replace(/\.(mp4|mkv|webm|mov|avi)$/i, '').replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 120) || 'video' }
function formatBytes(b = 0) { if (!b) return 'Desconocido'; const u = ['B','KB','MB','GB']; let i = 0; let s = Number(b); while (s >= 1024 && i < u.length - 1) { s /= 1024; i++ } return `${s.toFixed(i === 0? 0 : 2)} ${u[i]}` }

const isYtUrl = (t) => /(youtube\.com|youtu\.be)/i.test(t)
const isSpotifyUrl = (t) => /open\.spotify\.com/i.test(t)

export default {
  command: ['testplay'],
  category: 'downloader',
  isOwner:true,
  run: async ({ sock, msg, args, text, usedPrefix, command }) => {
    try {
      const isChannel = msg.chat.endsWith('@newsletter')
      const options = isChannel? undefined : { quoted: msg }
      const chatId = msg.chat
      const q = text?.trim()
      if (!q) return sock.sendMessage(msg.chat, { text: '《✧》 Por favor, menciona el nombre o URL.' }, options)
      await sock.sendMessage(chatId, { react: { text: '🕒', key: msg.key } })

      const timeoutMessage = `《✧》 *Tiempo de descarga agotado*\n\n> No seleccionaste ninguna opción a tiempo.\n> Vuelve a usar *${usedPrefix}${command}* y elige un servicio de descarga.\n\n> ⏰ *Límite: 10 minutos*`

      if (isYtUrl(q)) {
        const buttons = [
          { buttonId: `ytaudio|${q}`, buttonText: { displayText: '🎧 Audio' }, type: 1 },
          { buttonId: `ytvideo|${q}`, buttonText: { displayText: '🎥 Video' }, type: 1 }
        ]
        const sent = await sock.sendMessage(chatId, { text: `➩ Link detectado › YouTube\n> ❒ URL › *${q}*\n\nSelecciona (2 intentos / 10 min)`, buttons, footer: 'YouTube Downloader' }, options)
        let uses = 0; const maxUses = buttons.length
        const sentId = sent.key.id

        const collector = async (upsert) => {
          try {
            const m = upsert.messages?.[0]
            if (!m || m.key.fromMe || m.key.remoteJid!== chatId) return
            const btnId = m.message?.buttonsResponseMessage?.selectedButtonId || m.message?.templateButtonReplyMessage?.selectedId || ''
            const rawText = (m.message?.conversation || m.message?.extendedTextMessage?.text || '').toLowerCase().trim()
            let type, urlToDl = q
            if (btnId) { const p = btnId.split('|'); type = p[0]; urlToDl = p[1] || q }
            else { const ctx = m.message?.extendedTextMessage?.contextInfo; if (ctx?.stanzaId!== sentId) return; if (['audio','ytaudio','yt'].includes(rawText)) type = 'ytaudio'; else if (['video','ytvideo'].includes(rawText)) type = 'ytvideo'; else return }
            if (uses >= maxUses) return
            uses++
            if (uses >= maxUses) { clearTimeout(timer); sock.ev.off('messages.upsert', collector) }

            await sock.sendMessage(chatId, { react: { text: '🕒', key: m.key } })
            if (type === 'ytvideo') {
              let tempInput = path.join(tmpDir, `yt_${Date.now()}_in.mp4`), tempOutput = path.join(tmpDir, `yt_${Date.now()}_out.mp4`), tempOutput2 = path.join(tmpDir, `yt_${Date.now()}_out2.mp4`)
              try {
                const data = await getFareVideo(urlToDl, '360p')
                await downloadFile(data.descarga.url, tempInput)
                try { await execAsync(`ffmpeg -y -i "${tempInput}" -vf "scale=-2:'min(360,ih)'" -c:v libx264 -preset veryfast -crf 28 -c:a aac -b:a 96k -movflags +faststart "${tempOutput}"`) } catch { fs.copyFileSync(tempInput, tempOutput) }
                let finalPath = tempOutput
                if (fs.existsSync(finalPath) && fs.statSync(finalPath).size > max_video_size) { try { await execAsync(`ffmpeg -y -i "${tempOutput}" -vf "scale=-2:'min(360,ih)'" -c:v libx264 -preset veryfast -crf 28 -c:a aac -b:a 96k -movflags +faststart "${tempOutput2}"`); if (fs.existsSync(tempOutput2)) finalPath = tempOutput2 } catch {} }
                const size = fs.existsSync(finalPath)? fs.statSync(finalPath).size : 0
                if (size > max_video_size) await sock.sendMessage(chatId, { document: { url: finalPath }, mimetype: 'video/mp4', fileName: sanitizeFileName(data.titulo)+'.mp4', caption: `Tamaño: ${formatBytes(size)}` }, { quoted: m })
                else await sock.sendMessage(chatId, { video: { url: finalPath }, mimetype: 'video/mp4', fileName: sanitizeFileName(data.titulo)+'.mp4' }, { quoted: m })
              } catch (e) { await sock.sendMessage(chatId, { text: `> Error video: ${e.message}` }, { quoted: m }) }
              finally { try { if (fs.existsSync(tempInput)) fs.unlinkSync(tempInput) } catch {}; try { if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput) } catch {}; try { if (fs.existsSync(tempOutput2)) fs.unlinkSync(tempOutput2) } catch {} }
            } else {
              const dlUrl = await getMedia('yt', urlToDl); if (!dlUrl) return sock.sendMessage(chatId, { text: '《✧》 No se pudo obtener audio.' }, { quoted: m })
              await sock.sendMessage(chatId, { audio: { url: dlUrl }, fileName: `yt_${Date.now()}.mp3`, mimetype: 'audio/mpeg' }, { quoted: m })
            }
            await sock.sendMessage(chatId, { react: { text: '✅', key: m.key } })
          } catch (e) { console.log(e) }
        }

        sock.ev.on('messages.upsert', collector)
        const timer = setTimeout(async () => {
          try { sock.ev.off('messages.upsert', collector) } catch {}
          if (uses < maxUses) await sock.sendMessage(chatId, { text: timeoutMessage }, options)
        }, TIMEOUT_MS)

        return sock.sendMessage(chatId, { react: { text: '✅', key: msg.key } })
      }

      if (isSpotifyUrl(q)) {
        const dlUrl = await getMedia('spotify', q)
        if (!dlUrl) return sock.sendMessage(chatId, { text: '《✧》 No se pudo obtener el audio.' }, options)
        await sock.sendMessage(chatId, { audio: { url: dlUrl }, fileName: `spotify_${Date.now()}.mp3`, mimetype: 'audio/mpeg' }, options)
        return sock.sendMessage(chatId, { react: { text: '✅', key: msg.key } })
      }

      const [ytInfo, spInfo] = await Promise.all([ getYtLink(q), getSpotifyLink(q) ])
      if (!ytInfo &&!spInfo) return sock.sendMessage(chatId, { text: '《✧》 No se encontraron resultados' }, options)

      const title = ytInfo?.title || spInfo?.title || q
      const thumb = ytInfo?.thumbnail || spInfo?.image || null
      const ytUrl = ytInfo?.url || null
      const spotifyUrl = spInfo?.link || null

      let infoMessage = `➩ Descargando › ${title}\n`
      if (ytUrl) infoMessage += `> ❒ YouTube › *${ytUrl}*\n`
      if (spotifyUrl) infoMessage += `> ❒ Spotify › *${spotifyUrl}*\n`

      const buttons = [
        { buttonId: `ytaudio|${ytUrl}|${spotifyUrl}|${title}`, buttonText: { displayText: '🎧 YT Audio' }, type: 1 },
        { buttonId: `ytvideo|${ytUrl}|${spotifyUrl}|${title}`, buttonText: { displayText: '🎥 YT Video' }, type: 1 },
        { buttonId: `spotify|${ytUrl}|${spotifyUrl}|${title}`, buttonText: { displayText: '🎵 Spotify' }, type: 1 }
      ]

      let sent
      if (thumb) { try { const buf = await getBuffer(thumb); sent = await sock.sendMessage(chatId, { image: buf, caption: infoMessage, buttons, footer: `3 intentos / 10 min` }, options) } catch { sent = await sock.sendMessage(chatId, { text: infoMessage, buttons, footer: `3 intentos / 10 min` }, options) } }
      else sent = await sock.sendMessage(chatId, { text: infoMessage, buttons, footer: `3 intentos / 10 min` }, options)

      const sentId = sent.key.id
      let uses = 0; const maxUses = buttons.length

      const collector = async (upsert) => {
        try {
          const m = upsert.messages?.[0]
          if (!m || m.key.fromMe || m.key.remoteJid!== chatId) return
          const btnId = m.message?.buttonsResponseMessage?.selectedButtonId || m.message?.templateButtonReplyMessage?.selectedId || ''
          const rawText = (m.message?.conversation || m.message?.extendedTextMessage?.text || '').toLowerCase().trim()
          let type, yUrl, sUrl, fTitle
          if (btnId) { const p = btnId.split('|'); type = p[0]; yUrl = p[1]; sUrl = p[2]; fTitle = p[3] }
          else { const ctx = m.message?.extendedTextMessage?.contextInfo; if (ctx?.stanzaId!== sentId) return; if (['yt','ytaudio','audio'].includes(rawText)) type = 'ytaudio'; else if (['ytvideo','video'].includes(rawText)) type = 'ytvideo'; else if (['spotify'].includes(rawText)) type = 'spotify'; else return; yUrl = ytUrl; sUrl = spotifyUrl; fTitle = title }
          if (uses >= maxUses) return
          uses++
          if (uses >= maxUses) { clearTimeout(timer); sock.ev.off('messages.upsert', collector) }

          await sock.sendMessage(chatId, { react: { text: '🕒', key: m.key } })
          if (type === 'ytvideo') {
            let tempInput = path.join(tmpDir, `yt_${Date.now()}_in.mp4`), tempOutput = path.join(tmpDir, `yt_${Date.now()}_out.mp4`), tempOutput2 = path.join(tmpDir, `yt_${Date.now()}_out2.mp4`)
            try {
              const data = await getFareVideo(yUrl, '360p')
              await downloadFile(data.descarga.url, tempInput)
              try { await execAsync(`ffmpeg -y -i "${tempInput}" -vf "scale=-2:'min(360,ih)'" -c:v libx264 -preset veryfast -crf 28 -c:a aac -b:a 96k -movflags +faststart "${tempOutput}"`) } catch { fs.copyFileSync(tempInput, tempOutput) }
              let finalPath = tempOutput
              if (fs.existsSync(finalPath) && fs.statSync(finalPath).size > max_video_size) { try { await execAsync(`ffmpeg -y -i "${tempOutput}" -vf "scale=-2:'min(360,ih)'" -c:v libx264 -preset veryfast -crf 28 -c:a aac -b:a 96k -movflags +faststart "${tempOutput2}"`); if (fs.existsSync(tempOutput2)) finalPath = tempOutput2 } catch {} }
              const size = fs.existsSync(finalPath)? fs.statSync(finalPath).size : 0
              if (size > max_video_size) await sock.sendMessage(chatId, { document: { url: finalPath }, mimetype: 'video/mp4', fileName: sanitizeFileName(fTitle)+'.mp4' }, { quoted: m })
              else await sock.sendMessage(chatId, { video: { url: finalPath }, mimetype: 'video/mp4', fileName: sanitizeFileName(fTitle)+'.mp4' }, { quoted: m })
            } catch (e) { await sock.sendMessage(chatId, { text: `> Error video: ${e.message}` }, { quoted: m }) }
            finally { try { if (fs.existsSync(tempInput)) fs.unlinkSync(tempInput) } catch {}; try { if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput) } catch {}; try { if (fs.existsSync(tempOutput2)) fs.unlinkSync(tempOutput2) } catch {} }
          } else {
            const urlToDl = type === 'spotify'? sUrl : yUrl
            const dlUrl = await getMedia(type === 'ytaudio'? 'yt' : 'spotify', urlToDl)
            if (!dlUrl) return sock.sendMessage(chatId, { text: '《✧》 No se pudo obtener.' }, { quoted: m })
            await sock.sendMessage(chatId, { audio: { url: dlUrl }, fileName: `${fTitle}.mp3`, mimetype: 'audio/mpeg' }, { quoted: m })
          }
          await sock.sendMessage(chatId, { react: { text: '✅', key: m.key } })
        } catch (e) { console.log(e) }
      }

      sock.ev.on('messages.upsert', collector)
      const timer = setTimeout(async () => {
        try { sock.ev.off('messages.upsert', collector) } catch {}
        if (uses < maxUses) await sock.sendMessage(chatId, { text: timeoutMessage }, options)
      }, TIMEOUT_MS)

      await sock.sendMessage(chatId, { react: { text: '✅', key: msg.key } })

    } catch (e) {
      await sock.sendMessage(msg.chat, { text: `> Error: ${e.message}` }, { quoted: msg })
    }
  }
}