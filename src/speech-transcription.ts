import * as vscode from 'vscode';
import { exec, ChildProcess } from 'child_process';
import * as fs from 'fs';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface Segment {
  timestamps: {
    from: string;
    to: string;
  };

  offsets: {
    from: number;
    to: number;
  };

  text: string;
}

interface Result {
  language: string;
}

export interface Transcription {
  transcription: Segment[];
  result: Result;
}

export function gatherText(transcription: Transcription): string {
  return transcription.transcription
  // blank audio marker is added by whisper when there is no audio
  .filter((segment) => segment.text !== '[BLANK AUDIO]')
  .map((segment) => segment.text).join('');
}


class SpeechTranscription {
  private recordingProcess: ChildProcess | null = null;

  constructor(
    private outputDir: string,
    private outputChannel: vscode.OutputChannel,
  ) {}



  getOutputDir(): string {
    return this.outputDir;
  }

  startRecording(ffmpegCommandLine: string): void {
    try {
      this.recordingProcess = exec(
        ffmpegCommandLine,
        (error, stdout, stderr) => {
          if (error) {
            this.outputChannel.appendLine(`Whisper Assistant: error: ${error}`);
            return;
          }
          if (stderr) {
            this.outputChannel.appendLine(
              `Whisper Assistant: ffmpeg process error: ${stderr}`,
            );
            return;
          }
          this.outputChannel.appendLine(`Whisper Assistant: stdout: ${stdout}`);
        },
      );
    } catch (error) {
      this.outputChannel.appendLine(`Whisper Assistant: error: ${error}`);
    }
  }

  async stopRecording(): Promise<void> {
    if (!this.recordingProcess) {
      this.outputChannel.appendLine(
        'Whisper Assistant: No recording process found',
      );
      return;
    }
    this.outputChannel.appendLine('Whisper Assistant: Stopping recording');
    this.recordingProcess.kill();
    this.recordingProcess = null;
  }

  async transcribeRecording(
    whisperExecutablePath: string,
    whisperModelPath: string,
  ): Promise<Transcription | undefined> {
    try {
      this.outputChannel.appendLine(
        `Whisper Assistant: Transcribing recording using '${whisperModelPath}'`,
      );
      const { stdout, stderr } = await execAsync(
        // .json suffix is added automagically
        `${whisperExecutablePath} ${this.outputDir}/recording.wav --model ${whisperModelPath} --output-json --language en --output-file ${this.outputDir}/recording`,
      );
      this.outputChannel.appendLine(
        `Whisper Assistant: Transcription: ${stdout}`,
      );
      return await this.handleTranscription();
    } catch (error) {
      this.outputChannel.appendLine(`Whisper Assistant: error: ${error}`);
    }
  }

  private async handleTranscription(): Promise<Transcription | undefined> {
    try {
      const data = await fs.promises.readFile(
        `${this.outputDir}/recording.json`,
        'utf8',
      );
      if (!data) {
        this.outputChannel.appendLine(
          'Whisper Assistant: No transcription data found',
        );
        return;
      }
      const transcription: Transcription = JSON.parse(data);
      this.outputChannel.appendLine(`Whisper Assistant: ${gatherText(transcription)}`);

      return transcription;
    } catch (err) {
      this.outputChannel.appendLine(
        `Whisper Assistant: Error reading file from disk: ${err}`,
      );
    }
  }

  deleteFiles(): void {
    // Delete files
    fs.unlinkSync(`${this.outputDir}/recording.wav`);
    fs.unlinkSync(`${this.outputDir}/recording.json`);
  }
}

export default SpeechTranscription;
