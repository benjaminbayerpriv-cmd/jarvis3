import Foundation
import Speech
import AVFoundation

@main struct Bench {
    static func main() async throws {
        let locale = Locale(identifier: "de-DE")
        let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
        if let req = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            try await req.downloadAndInstall()
        }
        for path in CommandLine.arguments.dropFirst() {
            let t = SpeechTranscriber(locale: locale, preset: .transcription)
            let analyzer = SpeechAnalyzer(modules: [t])
            let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
            let start = Date()
            async let text: String = t.results.reduce("") { $0 + String($1.text.characters) }
            if let last = try await analyzer.analyzeSequence(from: file) {
                try await analyzer.finalizeAndFinish(through: last)
            }
            let result = try await text
            print(Int(Date().timeIntervalSince(start) * 1000), "ms |", result)
        }
    }
}
