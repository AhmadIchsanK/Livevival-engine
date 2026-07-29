import 'dotenv/config';
import Groq from 'groq-sdk';
import puppeteer from 'puppeteer';
import { createClient } from '@supabase/supabase-js';

// 1. Initialize Clients
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Initialize Groq SDK
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

async function startEngine() {
    console.log("Starting Dynamic Livevival Engine... (Version: Groq Vision - 1080p/30s)");
    
    // 2. Launch Headless Browser (Puppeteer)
    const browser = await puppeteer.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        headless: "new"
    });
    
    const page = await browser.newPage();
    
    // FIX 1: Set viewport to 1080p so the AI can actually read the small MLBB text
    await page.setViewport({ width: 1920, height: 1080 });
    
    // Variables to track state
    let currentMatchId = null;
    let currentUrl = null;

    // 3. Main Loop: Runs every 30 seconds to respect Groq's 8,000 TPM limit
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
                console.log(`New live match detected (${liveMatch.team_a_name} vs ${liveMatch.team_b_name}). Navigating to: ${liveMatch.youtube_url}`);
                await page.goto(liveMatch.youtube_url, { waitUntil: 'networkidle2', timeout: 60000 });
                currentMatchId = liveMatch.id;
                currentUrl = liveMatch.youtube_url;
                
                // Wait for the YouTube player UI to settle
                await new Promise(r => setTimeout(r, 5000));
                
                // FIX 2: Simulate a click in the center of the screen to start the video/hide the YouTube UI overlay
                await page.mouse.click(960, 540);
                await new Promise(r => setTimeout(r, 2000));
            }

            // C. Capture a screenshot frame from the stream
            console.log("Capturing 1080p frame...");
            const screenshotBase64 = await page.screenshot({ encoding: 'base64' });

            // D. Prompt Groq Vision to extract the scoreboard stats
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

            // Call Groq Vision Model
            const chatCompletion = await groq.chat.completions.create({
                model: "qwen/qwen3.6-27b",
                messages: [
                    {
                        role: "user",
                        content: [
                            { type: "text", text: prompt },
                            {
                                type: "image_url",
                                image_url: {
                                    url: `data:image/png;base64,${screenshotBase64}`
                                }
                            }
                        ]
                    }
                ],
                temperature: 0,
            });

            const responseText = chatCompletion.choices[0]?.message?.content || "{}";
            
            // Clean thinking tags, markdown syntax, and extraneous text
            let cleanText = responseText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
            cleanText = cleanText.replace(/```json/gi, '').replace(/```/g, '').trim();
            const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
            const finalJsonString = jsonMatch ? jsonMatch[0] : cleanText;

            const extractedStats = JSON.parse(finalJsonString);
            
            console.log(`[${liveMatch.team_a_name} vs ${liveMatch.team_b_name}] Extracted Stats:`, extractedStats);

            // E. Push the extracted stats to Supabase for the website to read
            const { error: upsertError } = await supabase
                .from('live_game_states')
                .upsert({
                    match_id: liveMatch.id,
                    game_time: extractedStats.game_time || "00:00",
                    team_a_kills: extractedStats.team_a_kills || 0,
                    team_b_kills: extractedStats.team_b_kills || 0,
                    team_a_gold: extractedStats.team_a_gold || 0,
                    team_b_gold: extractedStats.team_b_gold || 0,
                    team_a_towers: extractedStats.team_a_towers || 0,
                    team_b_towers: extractedStats.team_b_towers || 0
                }, { onConflict: 'match_id' });

            if (upsertError) {
                 console.error("Error pushing stats to Supabase:", upsertError);
            }

        } catch (error) {
            // Catch and log API or parsing errors so the loop doesn't crash entirely
            console.error("Engine execution loop error:", error?.message || JSON.stringify(error));
        }
    }, 30000); // 30000ms = 30 seconds to stay under 8,000 TPM
}

startEngine();
