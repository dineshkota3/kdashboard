import Foundation
import HealthKit

final class HealthKitSyncService {
    private let healthStore = HKHealthStore()
    private let calendar = Calendar.current
    private var observerQueries: [HKObserverQuery] = []

    var isHealthDataAvailable: Bool {
        HKHealthStore.isHealthDataAvailable()
    }

    func requestAuthorization() async throws {
        guard isHealthDataAvailable else {
            throw HealthKitSyncError.healthDataUnavailable
        }

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            healthStore.requestAuthorization(toShare: [], read: Self.readTypes) { success, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if success {
                    continuation.resume()
                } else {
                    continuation.resume(throwing: HealthKitSyncError.authorizationDenied)
                }
            }
        }
    }

    func enableBackgroundDelivery() async throws {
        guard isHealthDataAvailable else {
            throw HealthKitSyncError.healthDataUnavailable
        }

        for sampleType in Self.sampleTypes {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                healthStore.enableBackgroundDelivery(for: sampleType, frequency: .immediate) { success, error in
                    if let error {
                        continuation.resume(throwing: error)
                    } else if success {
                        continuation.resume()
                    } else {
                        continuation.resume(throwing: HealthKitSyncError.backgroundDeliveryUnavailable)
                    }
                }
            }
        }
    }

    func startObserverQueries(onChange: @escaping (@escaping () -> Void) -> Void) {
        guard observerQueries.isEmpty, isHealthDataAvailable else { return }

        for sampleType in Self.sampleTypes {
            let query = HKObserverQuery(sampleType: sampleType, predicate: nil) { _, completionHandler, error in
                guard error == nil else {
                    completionHandler()
                    return
                }

                onChange(completionHandler)
            }

            observerQueries.append(query)
            healthStore.execute(query)
        }
    }

    func fetchDailySummaries(daysBack: Int) async throws -> [HealthDay] {
        guard daysBack > 0 else { return [] }

        let endDate = calendar.startOfDay(for: Date()).addingTimeInterval(24 * 60 * 60)
        guard let startDate = calendar.date(byAdding: .day, value: -(daysBack - 1), to: calendar.startOfDay(for: Date())) else {
            return []
        }

        async let steps = dailySums(identifier: .stepCount, unit: .count(), startDate: startDate, endDate: endDate)
        async let energy = dailySums(identifier: .dietaryEnergyConsumed, unit: .kilocalorie(), startDate: startDate, endDate: endDate)
        async let protein = dailySums(identifier: .dietaryProtein, unit: .gram(), startDate: startDate, endDate: endDate)
        async let carbs = dailySums(identifier: .dietaryCarbohydrates, unit: .gram(), startDate: startDate, endDate: endDate)
        async let fat = dailySums(identifier: .dietaryFatTotal, unit: .gram(), startDate: startDate, endDate: endDate)
        async let exercise = dailySums(identifier: .appleExerciseTime, unit: .minute(), startDate: startDate, endDate: endDate)
        async let restingHr = dailySums(
            identifier: .appleRestingHeartRate,
            unit: .count().unitDivided(by: .minute()),
            startDate: startDate,
            endDate: endDate,
            options: .discreteAverage
        )
        async let sleep = sleepHoursByDay(startDate: startDate, endDate: endDate)
        async let activeEnergy = dailySums(identifier: .appleActiveEnergy, unit: .kilocalorie(), startDate: startDate, endDate: endDate)
        async let distance = dailySums(identifier: .distanceWalkingRunning, unit: .meter(), startDate: startDate, endDate: endDate)
        async let hrv = dailySums(
            identifier: .heartRateVariabilitySDNN,
            unit: .second(),
            startDate: startDate,
            endDate: endDate,
            options: .discreteAverage
        )
        async let respRate = dailySums(
            identifier: .appleRespiratoryRate,
            unit: .count().unitDivided(by: .minute()),
            startDate: startDate,
            endDate: endDate,
            options: .discreteAverage
        )
        async let vo2max = dailySums(
            identifier: .appleVO2Max,
            unit: HKUnit(from: "ml/kg*min"),
            startDate: startDate,
            endDate: endDate,
            options: .discreteAverage
        )

        let values = try await (steps, energy, protein, carbs, fat, exercise, restingHr, sleep, activeEnergy, distance, hrv, respRate, vo2max)
        let formatter = Self.dateFormatter
        let todayKey = formatter.string(from: Date())
        let hourly = try await hourlySpreadForToday()

        return dateRange(from: startDate, to: endDate).map { dayStart in
            let key = formatter.string(from: dayStart)
            return HealthDay(
                date: key,
                steps: Int((values.0[key] ?? 0).rounded()),
                dietaryEnergyKcal: rounded(values.1[key] ?? 0),
                proteinG: rounded(values.2[key] ?? 0),
                carbsG: rounded(values.3[key] ?? 0),
                fatG: rounded(values.4[key] ?? 0),
                exerciseMinutes: Int((values.5[key] ?? 0).rounded()),
                restingHr: Int((values.6[key] ?? 0).rounded()),
                sleepHours: rounded(values.7[key] ?? 0),
                activeEnergyKcal: rounded(values.8[key] ?? 0),
                distanceKm: rounded((values.9[key] ?? 0) / 1000),
                hrvSdnsMs: rounded(values.10[key] ?? 0),
                respiratoryRate: rounded(values.11[key] ?? 0),
                vo2max: rounded(values.12[key] ?? 0),
                hourly: key == todayKey ? hourly : nil
            )
        }
    }

    // Today's 24 hourly buckets for the tile drill-downs: steps + exercise as
    // hourly cumulative sums, heart rate as the hourly average of samples,
    // sleep as per-hour asleep/awake state. DST days yield 23/25 statistics
    // collections — buckets are indexed by wall-clock hour, last write wins.
    private func hourlySpreadForToday() async throws -> HealthHourly {
        let startOfDay = calendar.startOfDay(for: Date())
        let endOfDay = startOfDay.addingTimeInterval(24 * 60 * 60)

        func hourlyBuckets(
            identifier: HKQuantityTypeIdentifier,
            unit: HKUnit,
            options: HKStatisticsOptions
        ) async throws -> [Int] {
            var buckets = [Int](repeating: 0, count: 24)
            guard let quantityType = HKQuantityType.quantityType(forIdentifier: identifier) else {
                return buckets
            }
            let predicate = HKQuery.predicateForSamples(withStart: startOfDay, end: endOfDay, options: [.strictStartDate])

            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                let query = HKStatisticsCollectionQuery(
                    quantityType: quantityType,
                    quantitySamplePredicate: predicate,
                    options: options,
                    anchorDate: startOfDay,
                    intervalComponents: DateComponents(hour: 1)
                )
                query.initialResultsHandler = { _, result, error in
                    if let error {
                        continuation.resume(throwing: error)
                        return
                    }
                    result?.enumerateStatistics(from: startOfDay, to: endOfDay) { statistics, _ in
                        let hour = self.calendar.component(.hour, from: statistics.startDate)
                        guard hour >= 0, hour < 24 else { return }
                        if let average = statistics.averageQuantity(), options == .discreteAverage {
                            buckets[hour] = Int(average.doubleValue(for: unit).rounded())
                        } else if let sum = statistics.sumQuantity() {
                            buckets[hour] = Int(sum.doubleValue(for: unit).rounded())
                        }
                    }
                    continuation.resume()
                }
                healthStore.execute(query)
            }
            return buckets
        }

        let steps = try await hourlyBuckets(identifier: .stepCount, unit: .count(), options: .cumulativeSum)
        let exercise = try await hourlyBuckets(identifier: .appleExerciseTime, unit: .minute(), options: .cumulativeSum)
        let hr = try await hourlyBuckets(
            identifier: .heartRate,
            unit: .count().unitDivided(by: .minute()),
            options: .discreteAverage
        )

        // Sleep timeline: an hour is asleep when asleep samples cover more than
        // half of it (awake/inBed samples never count as asleep).
        var sleep = [Int](repeating: 0, count: 24)
        if let sleepType = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) {
            let predicate = HKQuery.predicateForSamples(withStart: startOfDay, end: endOfDay, options: [])
            let asleepValues: Set<Int> = [
                HKCategoryValueSleepAnalysis.asleepCore.rawValue,
                HKCategoryValueSleepAnalysis.asleepDeep.rawValue,
                HKCategoryValueSleepAnalysis.asleepREM.rawValue,
                HKCategoryValueSleepAnalysis.asleepUnspecified.rawValue
            ]
            let samples: [HKCategorySample] = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<[HKCategorySample], Error>) in
                let query = HKSampleQuery(sampleType: sleepType, predicate: predicate, limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, result, error in
                    if let error {
                        continuation.resume(throwing: error)
                        return
                    }
                    continuation.resume(returning: (result ?? []).compactMap { $0 as? HKCategorySample })
                }
                healthStore.execute(query)
            }
            for hour in 0..<24 {
                guard let hourStart = calendar.date(bySettingHour: hour, minute: 0, second: 0, of: startOfDay) else { continue }
                let hourEnd = hourStart.addingTimeInterval(3600)
                var asleepSeconds = 0.0
                for sample in samples where asleepValues.contains(sample.value) {
                    let overlapStart = max(sample.startDate, hourStart)
                    let overlapEnd = min(sample.endDate, hourEnd)
                    if overlapEnd > overlapStart {
                        asleepSeconds += overlapEnd.timeIntervalSince(overlapStart)
                    }
                }
                if asleepSeconds > 1800 {
                    sleep[hour] = 2
                } else if asleepSeconds > 0 {
                    sleep[hour] = 1
                }
            }
        }

        return HealthHourly(steps: steps, exerciseMin: exercise, hr: hr, sleep: sleep)
    }

    private func dailySums(
        identifier: HKQuantityTypeIdentifier,
        unit: HKUnit,
        startDate: Date,
        endDate: Date,
        options: HKStatisticsOptions = .cumulativeSum
    ) async throws -> [String: Double] {
        guard let quantityType = HKQuantityType.quantityType(forIdentifier: identifier) else {
            throw HealthKitSyncError.missingQuantityType
        }

        let predicate = HKQuery.predicateForSamples(withStart: startDate, end: endDate, options: [.strictStartDate])

        return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<[String: Double], Error>) in
            let query = HKStatisticsCollectionQuery(
                quantityType: quantityType,
                quantitySamplePredicate: predicate,
                options: options,
                anchorDate: startDate,
                intervalComponents: DateComponents(day: 1)
            )

            query.initialResultsHandler = { _, result, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }

                var sums: [String: Double] = [:]
                result?.enumerateStatistics(from: startDate, to: endDate) { statistics, _ in
                    let dateKey = Self.dateFormatter.string(from: statistics.startDate)
                    if let quantity = statistics.averageQuantity(), options == .discreteAverage {
                        sums[dateKey] = quantity.doubleValue(for: unit)
                    } else {
                        sums[dateKey] = statistics.sumQuantity()?.doubleValue(for: unit) ?? 0
                    }
                }
                continuation.resume(returning: sums)
            }

            healthStore.execute(query)
        }
    }

    // Sleep: category samples (Apple Watch sleep stages), summed per WAKE day
    // (a night belongs to the morning you woke up). Awake/inBed excluded.
    private func sleepHoursByDay(startDate: Date, endDate: Date) async throws -> [String: Double] {
        guard let sleepType = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) else {
            throw HealthKitSyncError.missingQuantityType
        }

        let predicate = HKQuery.predicateForSamples(withStart: startDate, end: endDate, options: [.strictStartDate])
        let asleepValues: Set<Int> = [
            HKCategoryValueSleepAnalysis.asleepCore.rawValue,
            HKCategoryValueSleepAnalysis.asleepDeep.rawValue,
            HKCategoryValueSleepAnalysis.asleepREM.rawValue,
            HKCategoryValueSleepAnalysis.asleepUnspecified.rawValue
        ]

        return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<[String: Double], Error>) in
            let query = HKSampleQuery(sampleType: sleepType, predicate: predicate, limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, samples, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }

                var seconds: [String: Double] = [:]
                for sample in samples ?? [] {
                    guard let category = sample as? HKCategorySample,
                          asleepValues.contains(category.value) else { continue }
                    let overlapStart = max(category.startDate, startDate)
                    let overlapEnd = min(category.endDate, endDate)
                    guard overlapEnd > overlapStart else { continue }
                    let key = Self.dateFormatter.string(from: category.endDate)
                    seconds[key, default: 0] += overlapEnd.timeIntervalSince(overlapStart)
                }

                var hours: [String: Double] = [:]
                for (key, value) in seconds {
                    hours[key] = (value / 3600 * 100).rounded() / 100
                }
                continuation.resume(returning: hours)
            }

            healthStore.execute(query)
        }
    }

    private func dateRange(from startDate: Date, to endDate: Date) -> [Date] {
        var dates: [Date] = []
        var current = startDate
        while current < endDate {
            dates.append(current)
            guard let next = calendar.date(byAdding: .day, value: 1, to: current) else { break }
            current = next
        }
        return dates
    }

    private func rounded(_ value: Double) -> Double {
        (value * 100).rounded() / 100
    }

    private static let dateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    private static let quantityTypes: [HKQuantityType] = [
        HKQuantityType.quantityType(forIdentifier: .stepCount),
        HKQuantityType.quantityType(forIdentifier: .dietaryEnergyConsumed),
        HKQuantityType.quantityType(forIdentifier: .dietaryProtein),
        HKQuantityType.quantityType(forIdentifier: .dietaryCarbohydrates),
        HKQuantityType.quantityType(forIdentifier: .dietaryFatTotal),
        HKQuantityType.quantityType(forIdentifier: .appleExerciseTime),
        HKQuantityType.quantityType(forIdentifier: .appleRestingHeartRate),
        HKQuantityType.quantityType(forIdentifier: .heartRate),
        HKQuantityType.quantityType(forIdentifier: .appleActiveEnergy),
        HKQuantityType.quantityType(forIdentifier: .distanceWalkingRunning),
        HKQuantityType.quantityType(forIdentifier: .heartRateVariabilitySDNN),
        HKQuantityType.quantityType(forIdentifier: .appleRespiratoryRate),
        HKQuantityType.quantityType(forIdentifier: .appleVO2Max)
    ].compactMap { $0 }

    private static let sleepType: HKCategoryType? = HKObjectType.categoryType(forIdentifier: .sleepAnalysis)

    private static var sampleTypes: [HKSampleType] {
        var types: [HKSampleType] = quantityTypes
        if let sleepType {
            types.append(sleepType)
        }
        return types
    }

    private static var readTypes: Set<HKObjectType> {
        Set(sampleTypes)
    }
}

enum HealthKitSyncError: LocalizedError {
    case authorizationDenied
    case backgroundDeliveryUnavailable
    case healthDataUnavailable
    case missingQuantityType

    var errorDescription: String? {
        switch self {
        case .authorizationDenied:
            return "Health permission was not granted."
        case .backgroundDeliveryUnavailable:
            return "Health background delivery could not be enabled."
        case .healthDataUnavailable:
            return "Health data is not available on this device."
        case .missingQuantityType:
            return "A requested HealthKit quantity type is unavailable."
        }
    }
}
