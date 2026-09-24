import XCTest
@testable import ADEDesktopDriverCore

final class HandleRegistryTests: XCTestCase {
    func testResolvesAHandleFromItsOwnObservation() throws {
        let registry = HandleRegistry()
        registry.record(observationId: "obs1", elementCount: 3)
        let handle = HandleRegistry.handle(observationId: "obs1", index: 2)
        XCTAssertEqual(handle, "obs-obs1:e:2")
        XCTAssertEqual(try registry.resolve(handle), ResolvedHandle(observationId: "obs1", index: 2))
    }

    func testRefusesAHandleFromAnObservationRetentionDropped() {
        let registry = HandleRegistry(retention: 2)
        registry.record(observationId: "a", elementCount: 5)
        registry.record(observationId: "b", elementCount: 5)
        let dropped = registry.record(observationId: "c", elementCount: 5)
        XCTAssertEqual(dropped, ["a"])
        XCTAssertThrowsError(try registry.resolve("obs-a:e:1")) { error in
            XCTAssertEqual(error as? HandleError, .expired("obs-a:e:1"))
            XCTAssertEqual((error as? HandleError)?.driverError.code, DriverErrorCode.handleExpired)
        }
        XCTAssertNoThrow(try registry.resolve("obs-c:e:1"))
    }

    func testRefusesAnIndexItsObservationNeverHad() {
        let registry = HandleRegistry()
        registry.record(observationId: "obs1", elementCount: 2)
        XCTAssertThrowsError(try registry.resolve("obs-obs1:e:2")) { error in
            XCTAssertEqual(error as? HandleError, .outOfRange("obs-obs1:e:2"))
        }
    }

    func testRefusesAMalformedHandleRatherThanGuessing() {
        let registry = HandleRegistry()
        registry.record(observationId: "obs1", elementCount: 4)
        for bad in ["", "obs1:e:1", "obs-obs1:1", "obs-obs1:e:", "obs-:e:1", "obs-obs1:e:x"] {
            XCTAssertThrowsError(try registry.resolve(bad), "\"\(bad)\" should not resolve") { error in
                XCTAssertEqual((error as? HandleError)?.driverError.code, DriverErrorCode.invalidArgument)
            }
        }
    }

    func testRerecordingAnObservationDoesNotDuplicateIt() {
        let registry = HandleRegistry(retention: 2)
        registry.record(observationId: "a", elementCount: 1)
        registry.record(observationId: "a", elementCount: 4)
        XCTAssertEqual(registry.activeObservationIds, ["a"])
        XCTAssertNoThrow(try registry.resolve("obs-a:e:3"))
    }

    func testNewestObservationIsTheOneTextTargetingWillUse() {
        let registry = HandleRegistry()
        registry.record(observationId: "a", elementCount: 1)
        registry.record(observationId: "b", elementCount: 1)
        XCTAssertEqual(registry.newestObservationId, "b")
        registry.forget(observationId: "b")
        XCTAssertEqual(registry.newestObservationId, "a")
        registry.reset()
        XCTAssertNil(registry.newestObservationId)
    }
}
