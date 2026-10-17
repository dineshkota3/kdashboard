import Foundation

enum AppConfig {
    // Per-person source (Phase 4): Keethu's phone sets
    // HEALTH_SYNC_SOURCE = apple_health_ios_keethu in LocalConfig.xcconfig.
    // Unset/placeholder falls back to the owner's source.
    static let source: String = {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: "HEALTH_SYNC_SOURCE") as? String else {
            return "apple_health_ios"
        }
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty || value.contains("$(") || value.contains("replace-with") {
            return "apple_health_ios"
        }
        return value
    }()

    static var healthSyncURL: URL {
        get throws {
            let raw = try requiredInfoValue("INSFORGE_HEALTH_SYNC_URL")
            guard let url = URL(string: raw), url.scheme == "https" else {
                throw AppConfigError.invalid("INSFORGE_HEALTH_SYNC_URL")
            }
            return url
        }
    }

    static var healthSyncToken: String {
        get throws {
            try requiredInfoValue("HEALTH_SYNC_TOKEN")
        }
    }

    private static func requiredInfoValue(_ key: String) throws -> String {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: key) as? String else {
            throw AppConfigError.missing(key)
        }

        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty || value.contains("$(") || value.contains("replace-with") {
            throw AppConfigError.missing(key)
        }
        return value
    }
}

enum AppConfigError: LocalizedError {
    case missing(String)
    case invalid(String)

    var errorDescription: String? {
        switch self {
        case .missing(let key):
            return "Missing \(key). Create Config/LocalConfig.xcconfig from the example."
        case .invalid(let key):
            return "Invalid \(key) in Config/LocalConfig.xcconfig."
        }
    }
}
