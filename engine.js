import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/genai';
import puppeteer from 'puppeteer';
import * as dotenv from 'dotenv';

dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function runEngine() {
    console.log("Starting Dynamic Livevival Engine...");
    
    const browser = await puppeteer.launch({ 
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] 
    });
    
    const page = await browser.newPage();
    let currentStreamUrl = null;
    let currentMatchId = null;

    setInterval(async () => {
        try {
            // 1. Fetch current live match from database
            const { data: liveMatches } = await supabase
                .from('matches')
                .select('*')
                .eq('status', 'live')
                .limit(1);

            if (!liveMatches || liveMatches.length === 0) {
                console.log("No match currently set to LIVE in Admin Dashboard. Waiting...");
                return;
            }

            const activeMatch = liveMatches[0];

            // 2. If stream URL changed or new match started, navigate browser
            if (activeMatch.youtube_url !== currentStreamUrl) {
                console.log(`New live match detected (${activeMatch.team_a_name} vs ${activeMatch.team_b_name}). Navigating to: ${activeMatch.youtube_url}`);
                currentStreamUrl = activeMatch.youtube_url;
                currentMatchId = activeMatch.id;
                await page.goto(currentStreamUrl, { waitUntil: 'networkidle2' });
            }

            // 3. Capture screenshot & process with AI
            console.log("Capturing frame...");
            const screenshotBase64 = await page.screenshot({ encoding: 'base64' });

            const response = await ai.models.generateContent({
                model: 'gemini-3.1-pro',
                contents: [
                    {
                        role: 'user',
                        parts: [
                            { inlineData: { mimeType: 'image/jpeg', data: screenshotBase64 } },
                            { text: 'Analyze this MLBB match screenshot. Return a strict JSON object with these keys: game_time (string), team_a_kills (number), team_b_kills (number), team_a_gold (number), team_b_gold (number), team_a_towers (number), team_b_towers (number), key_events (string, like "Savage" or "Lord Killed", leave empty if none). Only output the JSON, no markdown formatting.' }
                        ]
                    }
                ]
            });

            const textResponse = response.text().replace(/```json/g, '').replace(/```/g, '').trim();
            const stats = JSON.parse(textResponse);

            console.log(`[${activeMatch.team_a_name} vs ${activeMatch.team_b_name}] Extracted Stats:`, stats);

            // 4. Update Supabase
            await supabase.from('live_game_states').insert({
                match_id: currentMatchId,
                ...stats
            });

        } catch (err) {
            console.error("Engine execution loop error:", err.message);
        }
    }, 5000);
}

runEngine();
