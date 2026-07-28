import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/genai';
import puppeteer from 'puppeteer';
import * as dotenv from 'dotenv';

dotenv.config();

// 1. Initialize Connections
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// We will update these dynamically from the website in Phase 4!
const ACTIVE_MATCH_ID = "00000000-0000-0000-0000-000000000000"; 
const STREAM_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"; // Placeholder URL

async function runEngine() {
    console.log("Starting Livevival Engine on Railway...");
    
    // Launch headless browser (Cloud optimized)
    const browser = await puppeteer.launch({ 
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] 
    });
    
    const page = await browser.newPage();
    console.log(`Navigating to stream: ${STREAM_URL}`);
    await page.goto(STREAM_URL, { waitUntil: 'networkidle2' });

    // The 5-Second Extraction Loop
    setInterval(async () => {
        try {
            console.log("Capturing frame...");
            const screenshotBase64 = await page.screenshot({ encoding: 'base64' });

            console.log("Sending to Gemini 3.1 Pro...");
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
            
            // Clean the response to ensure perfect JSON
            const textResponse = response.text().replace(/```json/g, '').replace(/```/g, '').trim();
            const stats = JSON.parse(textResponse);

            console.log("Extracted Stats:", stats);

            // Push to Supabase Database
            const { error } = await supabase
                .from('live_game_states')
                .insert({
                    match_id: ACTIVE_MATCH_ID,
                    ...stats
                });

            if (error) {
                console.error("Database Insert Error:", error);
            } else {
                console.log(`Successfully updated database for game time: ${stats.game_time}`);
            }

        } catch (err) {
            console.error("Engine loop error:", err.message);
        }
    }, 5000); // 5000 milliseconds = 5 seconds
}

runEngine();
