import 'dotenv/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import puppeteer from 'puppeteer';
import { createClient } from '@supabase/supabase-js';

// --- ES MODULE UPDATE ---
// Converted require() to import to match package.json "type": "module"

// 1. Initialize Clients
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Initialize Gemini 1.5 Pro 
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });

async function startEngine() {
    console.log("Starting Dynamic Livevival Engine... (Version: Gemini 1.5 Pro - ESM)");
    
    // 2. Launch Headless Browser (Puppeteer)
    const browser = await puppeteer.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        headless: "new"
    });
    const page = await browser.newPage();
    
    // Variables to track state
    let currentMatchId = null;
    let currentUrl = null;

    // 3. Main Loop: Runs every 5 seconds
    setInterval(async () => {
        try {
            // A. Check Supabase for the active LIVE match
            const { data: matches, error: matchError } = await supabase
                .from('matches')
                .select('*')
                .eq('status', 'live')
                .limit(1);

            if (matchError) throw matchError;

            // If no match is live, wait and try again next loop
            if (!matches || matches.length === 0) {
                console.log("No match currently set to LIVE in Admin Dashboard. Waiting...");
                currentMatchId = null;
                return; 
            }

            const liveMatch = matches[0];
            
            // B. If a new live match is detected or the URL changed, navigate to it
            if (liveMatch.id !== currentMatchId || liveMatch.youtube_url !== currentUrl) {
                console.log(`New live match detected (${liveMatch.team_a} vs ${liveMatch.team_b}). Navigating to: ${liveMatch.youtube_url}`);
                await page.goto(liveMatch.youtube_url, { waitUntil: 'networkidle2', timeout: 60000 });
                currentMatchId = liveMatch.id;
                currentUrl = liveMatch.youtube_url;
                
                // Wait a few seconds for the YouTube player UI to settle
                await new Promise(r => setTimeout(r, 5000));
            }

            // C. Capture a screenshot frame from the stream
            console.log("Capturing frame...");
            const screenshotBase64 = await page.screenshot({ encoding: 'base64' });

            // D. Prompt Gemini 1.5 Pro to extract the scoreboard stats
            const prompt = `Analyze this Mobile Legends: Bang Bang (MLBB) esports screenshot.
            Return a JSON object with NO markdown formatting, just the raw JSON, containing these exact keys:
            - game_time (string, e.g. "12:45")
            - team_a_kills (number)
            - team_b_kills (number)
            - team_a_gold (number)
            - team_b_gold (number)
            - team_a_towers (number)
            - team_b_towers (number)
            If you can't clearly read a stat, use 0.`;

            const imagePart = {
                inlineData: {
                    data: screenshotBase64,
                    mimeType: "image/png"
                }
            };

            const result = await model.generateContent([prompt, imagePart]);
            const responseText = result.response.text();
            
            // Clean markdown blocks if Gemini added them (e.g., ```json ... ```)
            const cleanJsonString = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
            const extractedStats = JSON.parse(cleanJsonString);
            
            console.log(`[${liveMatch.team_a} vs ${liveMatch.team_b}] Extracted Stats:`, extractedStats);

            // E. Push the extracted stats to Supabase for the website to read
            const { error: upsertError } = await supabase
                .from('live_game_states')
                .upsert({
                    match_id: liveMatch.id,
                    team_a_name: liveMatch.team_a,
                    team_b_name: liveMatch.team_b,
                    game_time: extractedStats.game_time || "00:00",
                    team_a_kills: extractedStats.team_a_kills || 0,
                    team_b_kills: extractedStats.team_b_kills || 0,
                    team_a_gold: extractedStats.team_a_gold || 0,
                    team_b_gold: extractedStats.team_b_gold || 0,
                    team_a_towers: extractedStats.team_a_towers || 0,
                    team_b_towers: extractedStats.team_b_towers || 0,
                    updated_at: new Date().toISOString()
                }, { onConflict: 'match_id' });

            if (upsertError) {
                 console.error("Error pushing stats to Supabase:", upsertError);
            }

        } catch (error) {
            // Catch and log API or parsing errors so the loop doesn't crash entirely
            console.error("Engine execution loop error:", error?.message || JSON.stringify(error));
        }
    }, 5000); // 5000ms = 5 seconds
}

startEngine();
