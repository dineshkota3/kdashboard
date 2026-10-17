import Foundation

// Hourly spread for today's tile drill-downs: per-metric arrays, index = hour
// (0-23). hr uses 0 for "no sample that hour"; sleep is 0 none / 1 awake /
// 2 asleep. Shape matches the backend's `hourly` JSONB exactly.
struct HealthHourly: Codable {
    var steps: [Int]
    var exerciseMin: [Int]
    var hr: [Int]
    var sleep: [Int]

    enum CodingKeys: String, CodingKey {
        case steps
        case exerciseMin = "exercise_min"
        case hr
        case sleep
    }
}

struct HealthDay: Codable, Identifiable {
    let date: String
    let steps: Int
    let dietaryEnergyKcal: Double
    let proteinG: Double
    let carbsG: Double
    let fatG: Double
    let exerciseMinutes: Int
    let restingHr: Int
    let sleepHours: Double
    let activeEnergyKcal: Double
    let distanceKm: Double
    let hrvSdnsMs: Double
    let respiratoryRate: Double
    let vo2max: Double
    var hourly: HealthHourly?

    var id: String { date }
    var hasNutrition: Bool {
        dietaryEnergyKcal > 0 || proteinG > 0 || carbsG > 0 || fatG > 0
    }

    enum CodingKeys: String, CodingKey {
        case date
        case steps
        case dietaryEnergyKcal = "dietary_energy_kcal"
        case proteinG = "protein_g"
        case carbsG = "carbs_g"
        case fatG = "fat_g"
        case exerciseMinutes = "exercise_minutes"
        case restingHr = "resting_hr"
        case sleepHours = "sleep_hours"
        case activeEnergyKcal = "active_energy_kcal"
        case distanceKm = "distance_km"
        case hrvSdnsMs = "hrv_sdns_ms"
        case respiratoryRate = "respiratory_rate"
        case vo2max
        case hourly
    }
}

struct HealthSyncPayload: Codable {
    let source: String
    let timezone: String
    let days: [HealthDay]
}

struct HealthSyncResponse: Decodable {
    let ok: Bool
    let rows: Int?
    let error: String?
}
