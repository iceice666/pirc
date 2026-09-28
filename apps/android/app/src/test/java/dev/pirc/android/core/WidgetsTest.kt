package dev.pirc.android.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The same cases as the web's `goal.test.ts` and `todo.test.ts`. */
class WidgetsTest {
    @Test
    fun readsPhaseRoundsLimitAndReason() {
        assertEquals(
            GoalView("blocked", disarmed = false, rounds = 4, maxRounds = 10, objective = "Ship the goal tool", reason = "CI is down"),
            parseGoalWidget(listOf("GOAL · blocked · 4/10", "Ship the goal tool", "CI is down")),
        )
    }

    @Test
    fun marksADisarmedActiveGoalAndToleratesNoLimit() {
        val goal = parseGoalWidget(listOf("GOAL · active · disarmed · 2", "Keep going"))!!
        assertEquals(GoalView("active", disarmed = true, rounds = 2, objective = "Keep going"), goal)
        assertFalse(goal.running)
        assertTrue(goal.canResume)
        assertEquals("Waiting for resume", goal.phaseLabel)
        // Out of rounds: nothing to resume.
        assertFalse(parseGoalWidget(listOf("GOAL · paused · 5/5", "Done enough"))!!.canResume)
    }

    @Test
    fun ignoresAnythingThatIsNotAGoalWidget() {
        assertNull(parseGoalWidget(listOf("TODO · 1/2")))
        assertNull(parseGoalWidget(emptyList()))
        assertNull(parseGoalWidget(null))
    }

    @Test
    fun readsStatusesCategoriesAndBlockedFlags() {
        val list = parseTodoWidget(listOf("TODO · 1/3", "✓ write code", "▶ [web] Testing the dock", "☐ ship it (blocked)"))
        assertEquals(
            TodoList(
                listOf(
                    TodoItem("completed", "write code"),
                    TodoItem("in_progress", "Testing the dock", category = "web"),
                    TodoItem("pending", "ship it", blocked = true),
                ),
                done = 1,
                total = 3,
            ),
            list,
        )
        assertEquals("Testing the dock", list!!.headline)
    }

    @Test
    fun skipsLinesThatAreNotTasksAndEmptyLists() {
        assertEquals(1, parseTodoWidget(listOf("TODO · 0/9", "☐ one", "… 8 more"))!!.items.size)
        assertNull(parseTodoWidget(emptyList()))
        assertNull(parseTodoWidget(null))
    }

    @Test
    fun statusLineSkipsDockedWidgetsAndStatusesShownElsewhere() {
        assertEquals(
            listOf("Plan · step 2", "Compacting soon"),
            statusLine(
                mapOf("goal" to listOf("GOAL · active · 1"), "local-todo" to listOf("TODO · 0/1"), "plan" to listOf("Plan · step 2", "more"), "empty" to emptyList()),
                mapOf("background-task" to "1 running", "agent-team" to "2 agents", "compaction" to "Compacting soon", "blank" to ""),
            ),
        )
    }
}
