import * as vscode from 'vscode';
import SpeechTranscription, {
  Transcription,
} from './speech-transcription';
import * as fs from 'fs';
import { gatherText } from './speech-transcription';
import { exec } from 'child_process';

interface ExtensionState {
  myStatusBarItem: vscode.StatusBarItem | undefined;
  isRecording: boolean;
  isTranscribing: boolean;
  speechTranscription: SpeechTranscription | undefined;
  workspacePath: string | undefined;
  outputDir: string | undefined;
  recordingStartTime: number | undefined;
  outputChannel?: vscode.OutputChannel;
}

export const state: ExtensionState = {
  myStatusBarItem: undefined,
  isRecording: false,
  isTranscribing: false,
  speechTranscription: undefined,
  workspacePath: undefined,
  outputDir: undefined,
  recordingStartTime: undefined,
};

export async function activate(context: vscode.ExtensionContext) {
  initializeWorkspace();

  if (state.workspacePath === undefined || state.outputDir === undefined) {
    console.log('Please open a workspace directory before starting recording.');
    return;
  }

  const whisperExecutablePath = getWhisperExecutablePath();
  const whisperModelPath = getWhisperModelPath();

  const isFFmpegInstalled = checkIfInstalled(
    'ffmpeg',
  );

  if (!isFFmpegInstalled) {
    vscode.window.showErrorMessage(
      'FFmpeg is not installed. Please install ffmpeg for this extension to work properly.',
    );
  }

  const isWhisperInstalled = whisperExecutablePath && checkIfInstalled(
    whisperExecutablePath,
  );

  if (!isWhisperInstalled) {
    vscode.window.showErrorMessage(
      'Whisper is not installed. Please install Whisper for this extension to work properly.',
    );
  }

  const haveWhisperModel = whisperModelPath && fs.existsSync(whisperModelPath);
  if (!haveWhisperModel) {
    vscode.window.showErrorMessage(
      'Whisper model path is not set. Please select a Whisper model for this extension to work properly.',
    );
  }
  
  // Initialize the Recording class
  initializeOutputChannel();
  state.speechTranscription = new SpeechTranscription(
    state.outputDir as string,
    state.outputChannel as vscode.OutputChannel,
  );


  if (isFFmpegInstalled && isWhisperInstalled && haveWhisperModel) {
    registerCommands(context);
    initializeStatusBarItem();
    updateStatusBarItem();
    if (state.myStatusBarItem !== undefined) {
      context.subscriptions.push(state.myStatusBarItem);
    }
    console.log(
      'Congratulations, your extension "Whisper Assistant" is now active!',
    );
  }
}

export function initializeStatusBarItem(): void {
  // create a new status bar item that we can now manage
  state.myStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    1,
  );
  state.myStatusBarItem.command = 'whisperAssistant.toggleRecording';
  state.myStatusBarItem.show(); // Make sure the status bar item is shown
}

export function initializeWorkspace(): void {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders !== undefined) {
    state.workspacePath = workspaceFolders[0].uri.fsPath;
    const whisperDir = `${state.workspacePath}/.whisper`;
    if (!fs.existsSync(whisperDir)) {
      fs.mkdirSync(whisperDir);
    }
    state.outputDir = `${state.workspacePath}/.whisper`;
  }
}

function registerCommands(context: vscode.ExtensionContext): void {
  let toggleRecordingDisposable = vscode.commands.registerCommand(
    'whisperAssistant.toggleRecording',
    toggleRecordingCommand,
  );
  context.subscriptions.push(toggleRecordingDisposable);
}

export async function toggleRecordingCommand(): Promise<void> {
  if (
    state.workspacePath !== undefined &&
    state.outputDir !== undefined &&
    state.speechTranscription !== undefined &&
    !state.isTranscribing
  ) {
    if (!state.isRecording) {
      const ffmpegCommandLine = getFFmpegCommandLine();
      state.speechTranscription.startRecording(ffmpegCommandLine);
      state.recordingStartTime = Date.now();
      state.isRecording = true;
      updateStatusBarItem();

      setInterval(updateStatusBarItem, 1000);
    } else {
      state.speechTranscription.stopRecording();
      state.isTranscribing = true;
      state.isRecording = false;

      updateStatusBarItem();

      const progressOptions = {
        location: vscode.ProgressLocation.Notification,
        cancellable: false,
      };

      await vscode.window.withProgress(progressOptions, async (progress) => {
        const incrementData = initializeIncrementData();
        const interval = startProgressInterval(progress, incrementData);

        if (state.speechTranscription !== undefined) {
          const whisperExecutablePath = getWhisperExecutablePath()!;
          const whisperModelPath = getWhisperModelPath()!;
          const transcription: Transcription | undefined =
            await state.speechTranscription.transcribeRecording(whisperExecutablePath, whisperModelPath);

          if (transcription) {
            vscode.env.clipboard.writeText(gatherText(transcription)).then(() => {
              vscode.commands.executeCommand(
                'editor.action.clipboardPasteAction',
              );
            });
          }
        }

        await finalizeProgress(progress, interval, incrementData);
      });

      // Delete the recording/transcription files
      if (state.speechTranscription !== undefined) {
        state.speechTranscription.deleteFiles();
      }
    }
  }
}

function updateStatusBarItem(): void {
  if (state.myStatusBarItem === undefined) {
    return;
  }

  if (state.isRecording && state.recordingStartTime !== undefined) {
    const recordingDuration = Math.floor(
      (Date.now() - state.recordingStartTime) / 1000,
    );
    const minutes = Math.floor(recordingDuration / 60);
    const seconds = recordingDuration % 60;
    state.myStatusBarItem.text = `$(stop) ${minutes}:${
      seconds < 10 ? '0' + seconds : seconds
    }`;
  } else {
    state.myStatusBarItem.text = state.isTranscribing
      ? `$(loading~spin)`
      : `$(quote)`;
  }
}

function initializeIncrementData(): {
  increment: number;
  incrementInterval: number;
} {
  let increment: number = 0;
  const recordingDuration: number = state.recordingStartTime
    ? (Date.now() - state.recordingStartTime) / 1000
    : 0;
  const secondsDuration: number = recordingDuration % 60;
  const transcriptionTime: number = secondsDuration * 0.2 + 10; // 20% of the recording time + 10 seconds
  const incrementInterval: number = transcriptionTime * 30; // interval time to increment the progress bar
  return { increment, incrementInterval };
}

function startProgressInterval(
  progress: vscode.Progress<{ increment: number; message: string }>,
  incrementData: { increment: number; incrementInterval: number },
): NodeJS.Timeout {
  const interval = setInterval(() => {
    incrementData.increment += 1; // increment by 1% to slow down the progress

    progress.report({
      increment: incrementData.increment,
      message: 'Transcribing...',
    });
  }, incrementData.incrementInterval);

  return interval;
}

async function finalizeProgress(
  progress: vscode.Progress<{ increment: number; message: string }>,
  interval: NodeJS.Timeout,
  incrementData: { increment: number; incrementInterval: number },
): Promise<void> {
  clearInterval(interval);
  progress.report({
    increment: 100,
    message: 'Text has been transcribed and saved to the clipboard.',
  });
  state.isTranscribing = false;
  state.recordingStartTime = undefined;
  updateStatusBarItem();
  // Delay the closing of the progress pop-up by 2.5 second to allow the user to see the completion message
  await new Promise<void>((resolve) => setTimeout(resolve, 2500));
}

// This method is called when your extension is deactivated
export function deactivate() {
  // Dispose the status bar item
  if (state.myStatusBarItem) {
    state.myStatusBarItem.dispose();
  }

  // Reset variables
  state.isRecording = false;
  state.isTranscribing = false;
  state.speechTranscription = undefined;
  state.workspacePath = undefined;
  state.outputDir = undefined;
  state.recordingStartTime = undefined;

  // Log the deactivation
  console.log('Your extension "Whisper Assistant" is now deactivated');
}

function getWhisperExecutablePath(): string | undefined {
  const config = vscode.workspace.getConfiguration('whisper-assistant');
  const whisperExecutablePath = config.get('whisper_executable_path') as string;
  if (!whisperExecutablePath) {
    state.outputChannel?.appendLine(
      'Whisper Assistant: No whisper.cpp executable path found in configuration',
    );
    return undefined;
  }
  return whisperExecutablePath;
}

function getWhisperModelPath(): string | undefined {
  const config = vscode.workspace.getConfiguration('whisper-assistant');
  const whisperModelPath = config.get('whisper_model_path') as string;
  if (!whisperModelPath) {
    state.outputChannel?.appendLine(
      'Whisper Assistant: No ggml model path available for whisper.cpp',
    );
    return undefined;
  }
  return whisperModelPath;
}


function getFFmpegCommandLine(): string { 
  const config = vscode.workspace.getConfiguration('whisper-assistant');
  const ffmpegDevice = config.get('ffmpeg_device', ':0') as string;
  const ffmpegFormat = config.get('ffmpeg_format', 'avfoundation') as string;
  return `ffmpeg -f ${ffmpegFormat} -i ${ffmpegDevice} -ar 16000 -ac 1 -c:a pcm_s16le -f wav ${state.outputDir}/recording.wav`;
}

export function initializeOutputChannel(): void {
  state.outputChannel = vscode.window.createOutputChannel('Whisper Assistant');
}

export function checkIfInstalled(command: string): boolean {
    try {
      exec(`${command} --help`);
      return true;
    } catch (error) {
      return false;
    }
  }