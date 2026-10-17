import BackgroundTasks
import UIKit

final class AppDelegate: NSObject, UIApplicationDelegate {
    static let refreshTaskIdentifier = "com.example.kindle-dashboard.health-sync.refresh"
    private static let refreshInterval: TimeInterval = 15 * 60
    private let healthService = HealthKitSyncService()

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        BGTaskScheduler.shared.register(
            forTaskWithIdentifier: Self.refreshTaskIdentifier,
            using: nil
        ) { task in
            guard let task = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            self.handleRefresh(task: task)
        }
        healthService.startObserverQueries { completion in
            Task {
                defer { completion() }
                // Battery: phase 4 added more HealthKit types, so observer fires
                // often — throttle to the 5-min staleness window instead of a
                // full sync on every write.
                try? await BackgroundHealthSyncRunner.syncIfStale(daysBack: 7)
            }
        }
        Self.scheduleRefresh()
        return true
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        Task {
            try? await BackgroundHealthSyncRunner.syncIfStale(daysBack: 7)
        }
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        Self.scheduleRefresh()
    }

    static func scheduleRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: refreshTaskIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: refreshInterval)
        try? BGTaskScheduler.shared.submit(request)
    }

    private func handleRefresh(task: BGAppRefreshTask) {
        Self.scheduleRefresh()

        let syncTask = Task {
            do {
                try await BackgroundHealthSyncRunner.sync(daysBack: 7)
                task.setTaskCompleted(success: true)
            } catch {
                task.setTaskCompleted(success: false)
            }
        }

        task.expirationHandler = {
            syncTask.cancel()
        }
    }
}
