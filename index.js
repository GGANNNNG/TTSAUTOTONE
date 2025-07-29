import { getRequestHeaders, cancelTtsPlay, eventSource, event_types, getCurrentChatId, isStreamingEnabled, name2, saveSettingsDebounced, substituteParams, substituteParamsExtended } from '../../../../script.js';
import { ModuleWorkerWrapper, extension_settings, getContext, renderExtensionTemplateAsync } from '../../../extensions.js';
import { delay, escapeRegex, getBase64Async, getStringHash, onlyUnique } from '../../../utils.js';
import { power_user } from '../../../power-user.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { debounce_timeout } from '../../../constants.js';
import { SlashCommandEnumValue, enumTypes } from '../../../slash-commands/SlashCommandEnumValue.js';
import { enumIcons } from '../../../slash-commands/SlashCommandCommonEnumsProvider.js';
import { POPUP_TYPE, callGenericPopup } from '../../../popup.js';
import { GoogleNativeTtsProvider } from './google-native.js';
import { secret_state, SECRET_KEYS } from '../../../secrets.js';

const UPDATE_INTERVAL = 1000;
const wrapper = new ModuleWorkerWrapper(moduleWorker);

let voiceMapEntries = [];
let voiceMap = {}; // {charName:voiceid, charName2:voiceid2}
let lastChatId = null;
let lastMessage = null;
let lastMessageHash = null;
let currentInitVoiceMapPromise = null;

const DEFAULT_VOICE_MARKER = '[Default Voice]';
const DISABLED_VOICE_MARKER = 'disabled';
const PROVIDER_NAME = 'GoogleNative'; // 단일 공급자 이름 정의

let gttsProvider = new GoogleNativeTtsProvider(); // Google Native Provider를 직접 인스턴스화

export function getPreviewString(lang) {
    const previewStrings = {
        'en-US': 'The quick brown fox jumps over the lazy dog',
        'en-GB': 'Sphinx of black quartz, judge my vow',
        'fr-FR': 'Portez ce vieux whisky au juge blond qui fume',
        'de-DE': 'Victor jagt zwölf Boxkämpfer quer über den großen Sylter Deich',
        'it-IT': 'Pranzo d\'acqua fa volti sghembi',
        'es-ES': 'Quiere la boca exhausta vid, kiwi, piña y fugaz jamón',
        'es-MX': 'Fabio me exige, sin tapujos, que añada cerveza al whisky',
        'ru-RU': 'В чащах юга жил бы цитрус? Да, но фальшивый экземпляр!',
        'pt-BR': 'Vejo xá gritando que fez show sem playback.',
        'pt-PR': 'Todo pajé vulgar faz boquinha sexy com kiwi.',
        'uk-UA': 'Фабрикуймо гідність, лящім їжею, ґав хапаймо, з\'єднавці чаш!',
        'pl-PL': 'Pchnąć w tę łódź jeża lub ośm skrzyń fig',
        'cs-CZ': 'Příliš žluťoučký kůň úpěl ďábelské ódy',
        'sk-SK': 'Vyhŕňme si rukávy a vyprážajme čínske ryžové cestoviny',
        'hu-HU': 'Árvíztűrő tükörfúrógép',
        'tr-TR': 'Pijamalı hasta yağız şoföre çabucak güvendi',
        'nl-NL': 'De waard heeft een kalfje en een pinkje opgegeten',
        'sv-SE': 'Yxskaftbud, ge vårbygd, zinkqvarn',
        'da-DK': 'Quizdeltagerne spiste jordbær med fløde, mens cirkusklovnen Walther spillede på xylofon',
        'ja-JP': 'いろはにほへと　ちりぬるを　わかよたれそ　つねならむ　うゐのおくやま　けふこえて　あさきゆめみし　ゑひもせす',
        'ko-KR': '가나다라마바사아자차카타파하',
        'zh-CN': '我能吞下玻璃而不伤身体',
        'ro-RO': 'Muzicologă în bej vând whisky și tequila, preț fix',
        'bg-BG': 'Щъркелите се разпръснаха по цялото небе',
        'el-GR': 'Ταχίστη αλώπηξ βαφής ψημένη γη, δρασκελίζει υпέρ νωθρού κυνός',
        'fi-FI': 'Voi veljet, miksi juuri teille myin nämä vehkeet?',
        'he-IL': 'הקצינים צעקו: "כל הכבוד לצבא הצבאות!"',
        'id-ID': 'Jangkrik itu memang enak, apalagi kalau digoreng',
        'ms-MY': 'Muzik penyanyi wanita itu menggambarkan kehidupan yang penuh dengan duka nestapa',
        'th-TH': 'เป็นไงบ้างครับ ผมชอบกินข้าวผัดกระเพราหมูกроб',
        'vi-VN': 'Cô bé quàng khăn đỏ đang ngồi trên bãi cỏ xanh',
        'ar-SA': 'أَبْجَدِيَّة عَرَبِيَّة',
        'hi-IN': 'श्वेता ने श्वेता के श्वेते हाथों में श्वेता का श्वेता चावल पकड़ा',
    };
    const fallbackPreview = 'Neque porro quisquam est qui dolorem ipsum quia dolor sit amet';

    return previewStrings[lang] ?? fallbackPreview;
}

// TTS 공급자 저장 및 변경 로직 간소화
export function saveTtsProviderSettings() {
    extension_settings.gtts[PROVIDER_NAME] = gttsProvider.settings;
    updateVoiceMap();
    saveSettingsDebounced();
    console.info(`Saved settings for ${PROVIDER_NAME}: ${JSON.stringify(gttsProvider.settings)}`);
}

async function onNarrateOneMessage() {
    audioElement.src = '/sounds/silence.mp3';
    const context = getContext();
    const id = $(this).closest('.mes').attr('mesid');
    const message = context.chat[id];

    if (!message) {
        return;
    }

    resetTtsPlayback();
    processAndQueueTtsMessage(message);
    moduleWorker();
}

async function onNarrateText(args, text) {
    if (!text) {
        return '';
    }

    audioElement.src = '/sounds/silence.mp3';
    await initVoiceMap(true);

    const baseName = args?.voice || name2;
    const name = (baseName === 'SillyTavern System' ? DEFAULT_VOICE_MARKER : baseName) || DEFAULT_VOICE_MARKER;

    const voiceMapEntry = voiceMap[name] === DEFAULT_VOICE_MARKER
        ? voiceMap[DEFAULT_VOICE_MARKER]
        : voiceMap[name];

    if (!voiceMapEntry || voiceMapEntry === DISABLED_VOICE_MARKER) {
        toastr.info(`Specified voice for ${name} was not found. Check the TTS extension settings.`);
        return;
    }

    resetTtsPlayback();
    processAndQueueTtsMessage({ mes: text, name: name });
    await moduleWorker();

    await initVoiceMap(false);
    return '';
}

async function moduleWorker() {
    if (!extension_settings.gtts.enabled) {
        return;
    }

    processTtsQueue();
    processAudioJobQueue();
    updateUiAudioPlayState();
}

function resetTtsPlayback() {
    cancelTtsPlay();
    currentTtsJob = null;
    currentAudioJob = null;
    audioElement.currentTime = 0;
    audioElement.src = '';
    ttsJobQueue.splice(0, ttsJobQueue.length);
    audioJobQueue.splice(0, audioJobQueue.length);
    audioQueueProcessorReady = true;
}

function isTtsProcessing() {
    return ttsJobQueue.length > 0 || audioJobQueue.length > 0 || currentTtsJob != null || currentAudioJob != null;
}

function processAndQueueTtsMessage(message) {
    ttsJobQueue.push(message);
}

// Audio Control
let audioElement = new Audio();
audioElement.id = 'gtts_audio'; // FIX: Unique ID
audioElement.autoplay = true;

let audioJobQueue = [];
let currentAudioJob;
let audioPaused = false;
let audioQueueProcessorReady = true;

async function playAudioData(audioJob) {
    const { audioBlob, char } = audioJob;
    if (currentAudioJob == null) {
        console.log('Cancelled TTS playback because currentAudioJob was null');
        return;
    }
    if (audioBlob instanceof Blob) {
        const srcUrl = await getBase64Async(audioBlob);
        if (extension_settings.vrm?.enabled && typeof window['vrmLipSync'] === 'function') {
            await window['vrmLipSync'](audioBlob, char);
        }
        audioElement.src = srcUrl;
    } else if (typeof audioBlob === 'string') {
        audioElement.src = audioBlob;
    } else {
        throw `TTS received invalid audio data type ${typeof audioBlob}`;
    }
    audioElement.addEventListener('ended', completeCurrentAudioJob);
    audioElement.addEventListener('canplay', () => {
        console.debug('Starting Google Native TTS playback');
        audioElement.playbackRate = extension_settings.gtts.playback_rate;
        audioElement.play();
    });
}

// FIX: Make preview function name unique to avoid conflicts
window['gtts_preview'] = function (id) {
    gttsProvider.previewTtsVoice(id);
};

async function onTtsVoicesClick() {
    let popupText = '';
    try {
        const voiceIds = await gttsProvider.fetchTtsVoiceObjects();
        for (const voice of voiceIds) {
            popupText += `
            <div class="voice_preview">
                <span class="voice_lang">${voice.lang || ''}</span>
                <b class="voice_name">${voice.name}</b>
                <i onclick="gtts_preview('${voice.voice_id}')" class="fa-solid fa-play"></i>
            </div>`;
        }
    } catch (err) {
        popupText = `Could not load voices list. Check your API key. Error: ${err.message}`;
    }
    callGenericPopup(popupText, POPUP_TYPE.TEXT, '', { allowVerticalScrolling: true });
}

function updateUiAudioPlayState() {
    // FIX: Target unique extension menu item
    if (extension_settings.gtts.enabled) {
        $('#gttsExtensionMenuItem').show();
        let img = (!audioElement.paused || isTtsProcessing())
            ? 'fa-solid fa-stop-circle extensionsMenuExtensionButton'
            : 'fa-solid fa-circle-play extensionsMenuExtensionButton';
        $('#gtts_media_control').attr('class', img);
    } else {
        $('#gttsExtensionMenuItem').hide();
    }
}

function onAudioControlClicked() {
    audioElement.src = '/sounds/silence.mp3';
    let context = getContext();
    if (!audioElement.paused || isTtsProcessing()) {
        resetTtsPlayback();
    } else {
        processAndQueueTtsMessage(context.chat[context.chat.length - 1]);
    }
    updateUiAudioPlayState();
}

function addAudioControl() {
    // FIX: Use unique IDs for all created elements
    $('#tts_wand_container').append(`
        <div id="gttsExtensionMenuItem" class="list-group-item flex-container flexGap5">
            <div id="gtts_media_control" class="extensionsMenuExtensionButton "/></div>
            Google TTS Playback
        </div>`);
    $('#tts_wand_container').append(`
        <div id="gttsExtensionNarrateAll" class="list-group-item flex-container flexGap5">
            <div class="extensionsMenuExtensionButton fa-solid fa-radio"></div>
            Narrate All (Google)
        </div>`);
    $('#gttsExtensionMenuItem').attr('title', 'Google TTS play/pause').on('click', onAudioControlClicked);
    $('#gttsExtensionNarrateAll').attr('title', 'Narrate all messages in the current chat using Google TTS.').on('click', playFullConversation);
    updateUiAudioPlayState();
}


function completeCurrentAudioJob() {
    audioQueueProcessorReady = true;
    currentAudioJob = null;
    wrapper.update();
}

async function addAudioJob(response, char) {
    if (typeof response === 'string') {
        audioJobQueue.push({ audioBlob: response, char: char });
    } else {
        const audioData = await response.blob();
        if (!audioData.type.startsWith('audio/')) {
            throw `TTS received HTTP response with invalid data format. Expecting audio/*, got ${audioData.type}`;
        }
        audioJobQueue.push({ audioBlob: audioData, char: char });
    }
    console.debug('Pushed audio job to queue.');
}

async function processAudioJobQueue() {
    if (audioJobQueue.length === 0 || !audioQueueProcessorReady || audioPaused) {
        return;
    }
    try {
        audioQueueProcessorReady = false;
        currentAudioJob = audioJobQueue.shift();
        playAudioData(currentAudioJob);
    } catch (error) {
        toastr.error(error.toString());
        console.error(error);
        audioQueueProcessorReady = true;
    }
}

// TTS Control
let ttsJobQueue = [];
let currentTtsJob;

function completeTtsJob() {
    console.info(`Current TTS job for ${currentTtsJob?.name} completed.`);
    currentTtsJob = null;
}


async function tts(text, voiceId, char) {
    async function processResponse(response) {
        // RVC injection (기존 로직 유지)
        if (typeof window['rvcVoiceConversion'] === 'function' && extension_settings.rvc.enabled) {
            response = await window['rvcVoiceConversion'](response, char, text);
        }
        await addAudioJob(response, char);
    }

    try {
        const response = await gttsProvider.generateTts(text, voiceId);
        await processResponse(response);
    } catch (error) {
        toastr.error(`TTS generation failed: ${error.message}`);
        console.error('TTS Error:', error);
    } finally {
        completeTtsJob();
    }
}


async function getTonalTextFromGemini(text) {
    const apiKey = secret_state[SECRET_KEYS.MAKERSUITE];
    if (!apiKey) {
        throw new Error('Google AI (MakerSuite) API key is not set.');
    }

    let basePrompt = extension_settings.gtts.tts_tone_prompt;
    const language = extension_settings.gtts.tts_tone_language;
    const translationTemplate = extension_settings.gtts.tts_translation_prompt_template;

    let finalPrompt = basePrompt;

    if (language && language !== 'disabled' && translationTemplate) {
        const translationPrompt = substituteParamsExtended(translationTemplate, { language: language });
        finalPrompt += `\n\n${translationPrompt}`;
    }

    const messages = [
        { role: 'user', content: `${finalPrompt}\n\n${text}` },
    ];

    const parameters = {
        model: 'gemini-2.5-flash',
        messages: messages,
        temperature: 0.7,
        stream: false,
        chat_completion_source: 'makersuite',
    };

    try {
        const response = await fetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(parameters),
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('Gemini Tone Analysis API Error:', errorText);
            throw new Error(`Gemini Tone Analysis failed: ${errorText}`);
        }

        const data = await response.json();
        const result = data.candidates?.[0]?.content?.trim() ||
                       data.choices?.[0]?.message?.content?.trim() ||
                       data.text?.trim();

        if (!result) {
            console.error('Invalid response from Gemini Tone Analysis:', data);
            throw new Error('Could not extract tone analysis from Gemini response.');
        }

        console.log('Original Gemini Tone Analysis Output:', result);

        const finalResult = result.split('\n')
                                  .map(line => line.replace(/^>\s*/, '').trim())
                                  .filter(line => line.length > 0)
                                  .join('\n');

        console.log('Modified Gemini Output for TTS:', finalResult);
        return finalResult;

    } catch (error) {
        console.error('Failed to call Gemini for tone analysis:', error);
        toastr.error(`Gemini tone analysis failed: ${error.message}`);
        return text; // 오류 발생 시 원본 텍스트 반환
    }
}

async function processTtsQueue() {
    if (currentTtsJob || ttsJobQueue.length <= 0 || audioPaused) {
        return;
    }

    currentTtsJob = ttsJobQueue.shift();
    let text = currentTtsJob.mes;

    // 1. 순차적 나레이션 모드에서 톤 분석이 아직 수행되지 않은 경우
    if (extension_settings.gtts.auto_tone_sequential_narration && !currentTtsJob.isToneProcessed) {
        try {
            let tonalText = await getTonalTextFromGemini(text);

            // 요청된 로직: LLM이 "지시문: 「대사」" 형식으로 응답하면, 형식 수정을 위해 콜론(:)과 대사 사이에 개행(\n)을 삽입합니다.
            tonalText = tonalText.replace(/: *([“«「『＂].*?[”»」』＂]|".*?")/g, ':\n$1');

            const dialogueLines = tonalText.split('\n').filter(line => line.trim().length > 0);
            const newJobs = [];

            // 지시문과 대사를 2줄씩 짝지어 하나의 TTS 작업으로 그룹화합니다.
            for (let i = 0; i < dialogueLines.length; i += 2) {
                // 다음 줄(대사)이 있는지 확인하여 쌍을 이룹니다.
                if (dialogueLines[i + 1]) {
                    const combinedMessage = dialogueLines[i] + '\n' + dialogueLines[i + 1];
                    newJobs.push({
                        ...currentTtsJob,
                        mes: combinedMessage,
                        isToneProcessed: true,
                    });
                } else {
                    // 쌍이 맞지 않는 마지막 줄이 있다면 단독으로 처리합니다.
                    newJobs.push({
                        ...currentTtsJob,
                        mes: dialogueLines[i],
                        isToneProcessed: true,
                    });
                }
            }

            if (newJobs.length > 0) {
                // 새로 생성된 묶음 작업들을 큐의 맨 앞에 추가합니다.
                ttsJobQueue.unshift(...newJobs);
            }
        } catch (error) {
            toastr.error(`Sequential Tone TTS failed: ${error.message}`);
            console.error(error);
        } finally {
            completeTtsJob();
            return;
        }
    }
    // 2. 일반 톤 분석 모드(순차적 아님)
    else if (!currentTtsJob.isToneProcessed) {
        let tonalText = await getTonalTextFromGemini(text);

        // 요청된 로직: LLM이 "지시문: 「대사」" 형식으로 응답하면, 콜론(:)과 대사 사이에 개행(\n)을 삽입합니다.
        tonalText = tonalText.replace(/: *([“«「『＂].*?[”»」』＂]|".*?")/g, ':\n$1');

        text = tonalText;
    }

    text = substituteParams(text);

    text = text.replace(/!\[.*?]\([^)]*\)/g, '');

    // *** 로직 수정: 개행(\n)은 유지하고 다른 불필요한 공백만 정리 ***
    text = text.split('\n').map(line => line.replace(/[ \t]+/g, ' ').trim()).join('\n');

    // --- START: 수정된 접두사 로직 ---

    const prefixPrompt = extension_settings.gtts.tts_prefix_prompt?.trim();
    const prefixEveryDialogue = extension_settings.gtts.prefix_every_dialogue;

    // 자동 톤 분석을 항상 사용하므로, 관련 접두사 로직을 무조건 실행
    text = text.split('\n')
               .map(line => {
                   const trimmedLine = line.trim();
                   if (trimmedLine.length === 0) {
                       return ''; // 빈 줄 유지
                   }
                   // 따옴표로 시작하는 대사로 추정되는 줄 앞에 "Speaker: " 추가
                   if (trimmedLine.match(/^[“«「『＂"]/)) {
                       return `Speaker: ${line}`;
                   }
                   // 그렇지 않으면, 지시문으로 처리
                   else {
                       let instruction = line;
                       // `prefix_every_dialogue`가 켜져 있으면 모든 지시문에 접두사를 추가합니다.
                       if (prefixEveryDialogue && prefixPrompt) {
                           instruction = `${prefixPrompt} ${instruction}`;
                       }
                       return `Style instructions → ${instruction}`;
                   }
               })
               .filter(line => line.length > 0) // 처리 후 비어버린 줄 제거
               .join('\n');

    // `prefix_every_dialogue`가 꺼져 있을 경우, 첫 번째 지시문에만 접두사를 붙입니다.
    if (!prefixEveryDialogue && prefixPrompt) {
        text = `${prefixPrompt} ${text}`;
    }

    // --- END: 수정된 접두사 로직 ---

    console.log(`Google TTS: ${text}`);
    const char = currentTtsJob.name;

    if (char && !power_user.allow_name2_display) {
        const escapedChar = escapeRegex(char);
        text = text.replace(new RegExp(`^${escapedChar}:`, 'gm'), '');
    }
    if (char && !voiceMap[char]) await initVoiceMap();
    try {
        if (!text.trim()) { // 공백만 있는 텍스트는 무시하도록 .trim() 추가
            console.warn('Got empty text in TTS queue job.');
            completeTtsJob();
            return;
        }

        const voiceMapEntry = voiceMap[char] === DEFAULT_VOICE_MARKER ? voiceMap[DEFAULT_VOICE_MARKER] : voiceMap[char];

        if (!voiceMapEntry || voiceMapEntry === DISABLED_VOICE_MARKER) {
            throw `${char} not in voicemap. Configure character in extension settings voice map`;
        }
        const voice = await gttsProvider.getVoice(voiceMapEntry);
        const voiceId = voice.voice_id;
        if (voiceId == null) {
            toastr.error(`Specified voice for ${char} was not found. Check the TTS extension settings.`);
            throw `Unable to attain voiceId for ${char}`;
        }
        await tts(text, voiceId, char);
    } catch (error) {
        toastr.error(error.toString());
        console.error(error);
        currentTtsJob = null;
    }
}
async function playFullConversation() {
    resetTtsPlayback();

    if (!extension_settings.gtts.enabled) {
        return toastr.warning('Google TTS is disabled. Please enable it in the extension settings.');
    }

    const context = getContext();
    const chat = context.chat.filter(x => !x.is_system && x.mes !== '...' && x.mes !== '');

    if (chat.length === 0) {
        return toastr.info('No messages to narrate.');
    }

    ttsJobQueue = chat;
}

window['playFullGoogleConversation'] = playFullConversation; // FIX: Unique name

// Extension UI and Settings

const defaultSettings = {
    voiceMap: '',
    enabled: false,
    auto_generation: true,
    playback_rate: 1,
    auto_tone_sequential_narration: false,
    // 프롬프트 수정: 지시문과 대사 사이에 줄바꿈을 명시적으로 요구
    tts_tone_prompt: `You will be given a text that contains both narration and dialogue. Dialogue is enclosed in any of the following quotation marks: “”, «», 「」, 『』, or ＂＂. Your task is to analyze the emotional and situational context from the narration.

Then, for each line of dialogue, you MUST create a specific instruction for a Text-to-Speech (TTS) engine.
This instruction should start with a command like "Say in...", "Read with...", or "TTS in...".

The instruction must describe:
- Tone (e.g., a gentle, a stern, a nervous)
- Speaking speed (e.g., a slow, a fast)
- Style (e.g., a formal, a casual)
- Delivery/emotion (e.g., a cheerful, a hesitant)
- Accent or regional nuance (if any is implied)

Each instruction MUST end with a colon \`:\`, followed by a NEWLINE, and then the dialogue line on the next line.

🔹 Only output the dialogues with their corresponding instructions.
🔹 Do NOT include narration in your output.
🔹 Do NOT explain your reasoning.
🔹 Maintain the original order of dialogue.

---

Example output format:
> Say in a calm and reassuring tone with a soft Kansai dialect, speaking slowly:
「어서 와. 잘 찾아왔네. 여까지 오느라 고생 많았제?」
> Read with a friendly and welcoming tone, at a medium speed, in an informal style:
「서있지 말고 이리 온나. 니 자리 안내해줄게.」
> TTS in a spooky whisper:
"By the pricking of my thumbs... Something wicked this way comes!"
> Read this disclaimer in as fast a voice as possible while remaining intelligible:
"[The author] assumes no responsibility or liability for any errors or omissions in the content of this site. The information contained in this site is provided on an 'as is' basis with no guarantees of completeness, accuracy, usefulness or timeliness."

Now process the following text:
`,
    tts_translation_prompt_template: `Additionally, translate all dialogue and tone instructions into {{language}}.
Crucially, **both the instruction and the dialogue must be written entirely in {{language}}**.

The final output format MUST be: [Instruction in {{language}}]: followed by a NEWLINE, and then 「Dialogue in {{language}}」 on the next line.

🔹 Do NOT output the original dialogue.
🔹 Do NOT output instructions in English unless the target language is English.
🔹 Do NOT include narration in your output.
🔹 Do NOT explain your reasoning.

---
Example for target language "Japanese":
> TTS in an irritated and grumpy voice:
「また一つコレクションが増えたな。」
> Say with a sad and small voice:
「ごめんなさい…」

Example for target language "English":
> Read with a booming, confident voice:
"We will be victorious!"

Now process the following text and provide the output in **{{language}}**:`,
    tts_tone_language: 'disabled',
    tts_tone_custom_languages: [],
    tts_prefix_prompt: '',
    prefix_every_dialogue: false,
};


function updateToneLanguageDropdown() {
    const select = $('#gtts_tone_language_select');
    const currentValue = extension_settings.gtts.tts_tone_language;
    select.empty();

    const defaultLanguages = ['disabled', 'English', 'Korean', 'Japanese', 'Spanish'];
    const allLanguages = [...new Set([...defaultLanguages, ...(extension_settings.gtts.tts_tone_custom_languages || [])])];

    allLanguages.forEach(lang => {
        select.append($('<option>', {
            value: lang,
            text: lang,
        }));
    });

    select.val(currentValue);
}
function loadSettings() {
    if (!extension_settings.gtts) {
        extension_settings.gtts = {};
    }
    if (Object.keys(extension_settings.gtts).length === 0) {
        Object.assign(extension_settings.gtts, defaultSettings);
    }
    for (const key in defaultSettings) {
        if (!(key in extension_settings.gtts)) {
            extension_settings.gtts[key] = defaultSettings[key];
        }
    }
    // FIX: Target unique IDs
    $('#gtts_enabled').prop('checked', extension_settings.gtts.enabled);
    $('#gtts_auto_generation').prop('checked', extension_settings.gtts.auto_generation);
    $('#gtts_auto_tone_sequential_narration').prop('checked', extension_settings.gtts.auto_tone_sequential_narration);
    $('#gtts_playback_rate').val(extension_settings.gtts.playback_rate);
    $('#gtts_playback_rate_counter').val(Number(extension_settings.gtts.playback_rate).toFixed(2));
    $('#gtts_tone_prompt').val(extension_settings.gtts.tts_tone_prompt);
    $('#gtts_translation_prompt').val(extension_settings.gtts.tts_translation_prompt_template);
    $('#gtts_prefix_prompt').val(extension_settings.gtts.tts_prefix_prompt);
    $('#gtts_prefix_every_dialogue').prop('checked', extension_settings.gtts.prefix_every_dialogue);
    updateToneLanguageDropdown();

    $('body').toggleClass('gtts', extension_settings.gtts.enabled);
}

function setTtsStatus(status, success) {
    // FIX: Target unique status element
    $('#gtts_status').text(status).css('color', success ? '' : 'red');
}

function onRefreshClick() {
    gttsProvider.voices = [];
    initVoiceMap().then(() => {
        setTtsStatus('Successfully reloaded voices', true);
        toastr.success('Google Native voice list has been reloaded.');
    }).catch(error => {
        toastr.error(error.toString());
        console.error(error);
        setTtsStatus(error.message, false);
    });
}

function onEnableClick() {
    extension_settings.gtts.enabled = $(this).is(':checked');
    updateUiAudioPlayState();
    saveSettingsDebounced();
    $('body').toggleClass('gtts', extension_settings.gtts.enabled);
}

function createCheckboxHandler(settingName) {
    return function() {
        extension_settings.gtts[settingName] = $(this).is(':checked');
        saveSettingsDebounced();
    };
}

// Event handlers
const onAutoGenerationClick = createCheckboxHandler('auto_generation');
const onAutoToneSequentialNarrationClick = createCheckboxHandler('auto_tone_sequential_narration');
const onPrefixEveryDialogueClick = createCheckboxHandler('prefix_every_dialogue');
const onTonePromptInput = function() {
    extension_settings.gtts.tts_tone_prompt = $(this).val();
    saveSettingsDebounced();
};

const onTranslationPromptInput = function() {
    extension_settings.gtts.tts_translation_prompt_template = $(this).val();
    saveSettingsDebounced();
};

const onPrefixPromptInput = function() { // 새 핸들러 추가
    extension_settings.gtts.tts_prefix_prompt = $(this).val();
    saveSettingsDebounced();
};

const onRestoreTonePromptClick = function() {
    $('#gtts_tone_prompt').val(defaultSettings.tts_tone_prompt);
    extension_settings.gtts.tts_tone_prompt = defaultSettings.tts_tone_prompt;
    saveSettingsDebounced();
};

const onRestoreTranslationPromptClick = function() {
    $('#gtts_translation_prompt').val(defaultSettings.tts_translation_prompt_template);
    extension_settings.gtts.tts_translation_prompt_template = defaultSettings.tts_translation_prompt_template;
    saveSettingsDebounced();
};

const onToneLanguageChange = function() {
    extension_settings.gtts.tts_tone_language = $(this).val();
    saveSettingsDebounced();
};

const onAddCustomLanguageClick = async function() {
    const newLang = await callGenericPopup('Enter the new language name (e.g., "French"):', POPUP_TYPE.INPUT);
    if (newLang) {
        if (!extension_settings.gtts.tts_tone_custom_languages) {
            extension_settings.gtts.tts_tone_custom_languages = [];
        }
        if (!extension_settings.gtts.tts_tone_custom_languages.includes(newLang)) {
            extension_settings.gtts.tts_tone_custom_languages.push(newLang);
            extension_settings.gtts.tts_tone_language = newLang; // 새로 추가한 언어를 바로 선택
            updateToneLanguageDropdown();
            saveSettingsDebounced();
        }
    }
};

async function loadTtsProvider() {
    // FIX: Target unique settings container
    $('#gtts_provider_settings').html(gttsProvider.settingsHtml);

    if (!(PROVIDER_NAME in extension_settings.gtts)) {
        extension_settings.gtts[PROVIDER_NAME] = {};
    }
    await gttsProvider.loadSettings(extension_settings.gtts[PROVIDER_NAME]);
    await initVoiceMap();
}

async function onChatChanged() {
    resetTtsPlayback();
    const voiceMapInit = initVoiceMap();
    await Promise.race([voiceMapInit, delay(debounce_timeout.relaxed)]);
    lastMessage = null;
}

async function onMessageEvent(messageId, lastCharIndex) {
    if (!extension_settings.gtts.enabled || !extension_settings.gtts.auto_generation) return;
    const context = getContext();
    if (!context.groupId && context.characterId === undefined) return;

    if (context.chatId !== lastChatId) {
        lastChatId = context.chatId;
        lastMessageHash = getStringHash(context.chat[messageId]?.mes ?? '');
        if (context.chat.length === 1) lastMessageHash = -1;
    }

    const message = structuredClone(context.chat[messageId]);
    const hashNew = getStringHash(message?.mes ?? '');
    if (message.is_system || hashNew === lastMessageHash) return;

    if (lastCharIndex) message.mes = message.mes.substring(0, lastCharIndex);

    const isLastMessageInCurrent = () =>
        lastMessage &&
        typeof lastMessage === 'object' &&
        message.swipe_id === lastMessage.swipe_id &&
        message.name === lastMessage.name &&
        message.is_user === lastMessage.is_user &&
        message.mes.indexOf(lastMessage.mes) !== -1;

    if (isLastMessageInCurrent()) {
        const tmp = structuredClone(message);
        message.mes = message.mes.replace(lastMessage.mes, '');
        lastMessage = tmp;
    } else {
        lastMessage = structuredClone(message);
    }

    if (!message || message.mes === '...' || message.mes === '') return;

    lastMessageHash = hashNew;
    lastChatId = context.chatId;

    console.debug(`Adding message from ${message.name} for Google TTS processing: "${message.mes}"`);
    processAndQueueTtsMessage(message);
}

async function onMessageDeleted() {
    const context = getContext();
    lastChatId = context.chatId;
    const messageHash = getStringHash((context.chat.length && context.chat[context.chat.length - 1].mes) ?? '');
    if (messageHash === lastMessageHash) return;
    lastMessageHash = messageHash;
    lastMessage = context.chat.length ? structuredClone(context.chat[context.chat.length - 1]) : null;
    resetTtsPlayback();
}

function getCharacters(unrestricted) {
    const context = getContext();
    if (unrestricted) {
        const names = context.characters.map(char => char.name);
        names.unshift(DEFAULT_VOICE_MARKER);
        return names.filter(onlyUnique);
    }
    let characters = [DEFAULT_VOICE_MARKER, context.name1];
    if (context.groupId === null) {
        characters.push(context.name2);
    } else {
        const group = context.groups.find(group => context.groupId == group.id);
        for (let member of group.members) {
            const character = context.characters.find(char => char.avatar == member);
            if (character) characters.push(character.name);
        }
    }
    return characters.filter(onlyUnique);
}

function sanitizeId(input) {
    let sanitized = encodeURIComponent(input).replace(/[^a-zA-Z0-9-_]/g, '');
    if (!/^[a-zA-Z]/.test(sanitized)) sanitized = 'element_' + sanitized;
    return sanitized;
}

function updateVoiceMap() {
    const tempVoiceMap = {};
    for (const voice of voiceMapEntries) {
        if (voice.voiceId !== null) {
            tempVoiceMap[voice.name] = voice.voiceId;
        }
    }
    if (Object.keys(tempVoiceMap).length !== 0) {
        voiceMap = tempVoiceMap;
        console.log(`Google Native Voicemap updated to ${JSON.stringify(voiceMap)}`);
    }
    if (!extension_settings.gtts[PROVIDER_NAME]) {
        extension_settings.gtts[PROVIDER_NAME] = {};
    }
    extension_settings.gtts[PROVIDER_NAME].voiceMap = voiceMap;
    saveSettingsDebounced();
}


class VoiceMapEntry {
    name;
    voiceId;
    selectElement;
    constructor(name, voiceId = DEFAULT_VOICE_MARKER) {
        this.name = name;
        this.voiceId = voiceId;
        this.selectElement = null;
    }

    addUI(voiceIds) {
        let sanitizedName = sanitizeId(this.name);
        let defaultOption = this.name === DEFAULT_VOICE_MARKER ?
            `<option>${DISABLED_VOICE_MARKER}</option>` :
            `<option>${DEFAULT_VOICE_MARKER}</option><option>${DISABLED_VOICE_MARKER}</option>`;

        // FIX: Use unique IDs and classes for all generated elements
        let template = `
            <div class='gtts_voicemap_block_char flex-container flexGap5'>
                <span id='gtts_voicemap_char_label_${sanitizedName}'>${this.name}</span>
                <select id='gtts_voicemap_char_select_${sanitizedName}'>
                    ${defaultOption}
                </select>
            </div>
        `;
        $('#gtts_voicemap_block').append(template);

        // Populate voice ID select list
        for (const voiceId of voiceIds) {
            const option = document.createElement('option');
            option.innerText = voiceId.name;
            option.value = voiceId.name;
            $(`#gtts_voicemap_char_select_${sanitizedName}`).append(option);
        }

        this.selectElement = $(`#gtts_voicemap_char_select_${sanitizedName}`);
        this.selectElement.on('change', args => this.onSelectChange(args));
        this.selectElement.val(this.voiceId);
    }

    onSelectChange(args) {
        this.voiceId = this.selectElement.find(':selected').val();
        updateVoiceMap();
    }
}
export async function initVoiceMap(unrestricted = false) {
    if (currentInitVoiceMapPromise) return currentInitVoiceMapPromise;
    currentInitVoiceMapPromise = (async () => {
        const initialChatId = getCurrentChatId();
        try {
            await initVoiceMapInternal(unrestricted);
        } finally {
            currentInitVoiceMapPromise = null;
        }
        if (initialChatId !== getCurrentChatId()) {
            await initVoiceMap(unrestricted);
        }
    })();
    return currentInitVoiceMapPromise;
}
function parseVoiceMap(voiceMapString) {
    let parsedVoiceMap = {};
    for (const [charName, voiceId] of voiceMapString
        .split(',')
        .map(s => s.split(':'))) {
        if (charName && voiceId) {
            parsedVoiceMap[charName.trim()] = voiceId.trim();
        }
    }
    return parsedVoiceMap;
}

async function initVoiceMapInternal(unrestricted) {
    // FIX: Gate on its own unique 'enabled' checkbox
    const enabled = $('#gtts_enabled').is(':checked');
    if (!enabled) {
        return;
    }

    try {
        await gttsProvider.checkReady();
    } catch (error) {
        const message = `Google Native TTS Provider not ready. ${error}`;
        setTtsStatus(message, false);
        return;
    }

    setTtsStatus('Google Native TTS Provider Loaded', true);

    // FIX: Clear its own unique voiceMap block
    $('#gtts_voicemap_block').empty();
    voiceMapEntries = [];

    const characters = getCharacters(unrestricted);

    // FIX: Correctly read saved voiceMap from its own settings object
    let voiceMapFromSettings = {};
    const saved = extension_settings.gtts[PROVIDER_NAME]?.voiceMap; // Corrected path
    if (saved) {
        if (typeof saved === 'string' && saved) { // check for non-empty string
            voiceMapFromSettings = parseVoiceMap(saved);
        } else if (typeof saved === 'object') {
            voiceMapFromSettings = saved;
        }
    }


    let voiceIdsFromProvider;
    try {
        voiceIdsFromProvider = await gttsProvider.fetchTtsVoiceObjects();
    }
    catch {
        toastr.error('Google Native TTS Provider failed to return voice ids.');
        return; // Exit if voices can't be fetched
    }

    for (const character of characters) {
        if (character === 'SillyTavern System') {
            continue;
        }
        let voiceId;
        if (character in voiceMapFromSettings) {
            voiceId = voiceMapFromSettings[character];
        } else if (character === DEFAULT_VOICE_MARKER) {
            voiceId = DISABLED_VOICE_MARKER;
        } else {
            voiceId = DEFAULT_VOICE_MARKER;
        }
        const voiceMapEntry = new VoiceMapEntry(character, voiceId);
        voiceMapEntry.addUI(voiceIdsFromProvider);
        voiceMapEntries.push(voiceMapEntry);
    }
    updateVoiceMap();
}

// FIX: This entire jQuery block has been revised to use unique IDs and avoid conflicts.
jQuery(async function () {
    const addCustomTtsButton = (mesBlock) => {
        if (mesBlock.find('.mes_google_native_narrate').length > 0) {
            return;
        }
        const extraMesButtons = mesBlock.find('.extraMesButtons');
        const narrateButton = $('<div>')
            .addClass('mes_button mes_google_native_narrate fa-solid fa-headphones-simple interactable')
            .attr({ 'title': 'Listen with Google TTS', 'tabindex': '0' });
        extraMesButtons.prepend(narrateButton);
    };

    function addButtonsToExistingMessages() {
        $('#chat .mes').each(function() {
            addCustomTtsButton($(this));
        });
    }

    const chatObserver = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (node.nodeType === 1 && $(node).hasClass('mes')) {
                    addCustomTtsButton($(node));
                }
            });
        });
    });
    chatObserver.observe(document.getElementById('chat'), { childList: true, subtree: true });

    // Render the settings template
    const settingsHtmlString = await renderExtensionTemplateAsync('third-party/google-native-tts', 'settings');
    const settingsHtml = $(settingsHtmlString);

    // Append the modified, non-conflicting settings UI
    $('#extensions_settings').append(settingsHtml);

    // Attach event handlers using the new, unique IDs
    $('#gtts_refresh').on('click', onRefreshClick);
    $('#gtts_enabled').on('click', onEnableClick);
    $('#gtts_auto_generation').on('click', onAutoGenerationClick);
    $('#gtts_auto_tone_sequential_narration').on('click', onAutoToneSequentialNarrationClick);
    $('#gtts_voices').on('click', onTtsVoicesClick);
    $('#gtts_tone_prompt').on('input', onTonePromptInput);
    $('#gtts_translation_prompt').on('input', onTranslationPromptInput);
    $('#gtts_prefix_prompt').on('input', onPrefixPromptInput);
    $('#gtts_prefix_every_dialogue').on('click', onPrefixEveryDialogueClick);
    $('#gtts_restore_tone_prompt').on('click', onRestoreTonePromptClick);
    $('#gtts_restore_translation_prompt').on('click', onRestoreTranslationPromptClick);
    $('#gtts_tone_language_select').on('change', onToneLanguageChange);
    $('#gtts_add_custom_language').on('click', onAddCustomLanguageClick);
    $('#gtts_playback_rate').on('input', function () {
        const value = $(this).val();
        extension_settings.gtts.playback_rate = value;
        $('#gtts_playback_rate_counter').val(Number(value).toFixed(2));
        saveSettingsDebounced();
    });

    // Use the unique class for the click handler
    $(document).on('click', '.mes_google_native_narrate', onNarrateOneMessage);

    // Initial setup
    loadSettings();
    loadTtsProvider();
    addAudioControl();
    addButtonsToExistingMessages();
    setInterval(wrapper.update.bind(wrapper), UPDATE_INTERVAL);

    // Event listeners
    eventSource.on(event_types.MESSAGE_SWIPED, resetTtsPlayback);
    eventSource.on(event_types.CHAT_CHANGED, ()=>{
        onChatChanged();
        addButtonsToExistingMessages();
    });
    eventSource.on(event_types.MESSAGE_DELETED, onMessageDeleted);
    eventSource.on(event_types.GROUP_UPDATED, onChatChanged);
    eventSource.makeLast(event_types.CHARACTER_MESSAGE_RENDERED, (messageId) => onMessageEvent(messageId));
    eventSource.makeLast(event_types.USER_MESSAGE_RENDERED, (messageId) => onMessageEvent(messageId));

    // Unique slash command
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'gspeak',
        callback: async (args, value) => {
            await onNarrateText(args, value);
            return '';
        },
        aliases: ['gnarrate', 'gtts'],
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'gvoice',
                description: 'google tts character voice name',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                enumProvider: () => Object.keys(voiceMap).map(voiceName => new SlashCommandEnumValue(voiceName, null, enumTypes.enum, enumIcons.voice)),
            }),
        ],
        unnamedArgumentList: [new SlashCommandArgument('text', [ARGUMENT_TYPE.STRING], true)],
        helpString: 'Narrates text using Google Native TTS. Use `gvoice="Char Name"` to specify voice.',
    }));

    document.body.appendChild(audioElement);
});