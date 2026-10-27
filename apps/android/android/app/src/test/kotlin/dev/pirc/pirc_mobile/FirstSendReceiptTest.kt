package dev.pirc.pirc_mobile
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
class FirstSendReceiptTest {
    private fun value(n:Int=0,state:String="admission_failed",outcome:String="not_admitted",stop:Boolean=false) = buildJsonObject {
        put("state",state);put("accepted",true);put("nodeMapped",true);put("cleanupPending",false)
        put("messageAdmission",buildJsonObject {put("attemptNumber",n);put("commandId","cmd-$n");put("outcome",outcome);put("stopRequested",stop);put("stopConfirmed",stop);put("retryEligible",state=="admission_failed")})
    }
    private fun JsonObject.admission()=getValue("messageAdmission").jsonObject
    @Test fun stalePredecessorCannotDowngradeNewerAttemptOrBorrowItsRejection() {
        val newer=value(1,"outcome_unknown","outcome_unknown")
        val merged=mergeFirstPreparation(newer,value())
        assertEquals("outcome_unknown",merged["state"]?.jsonPrimitive?.content)
        assertEquals(1,merged.admission()["attemptNumber"]?.jsonPrimitive?.int)
        assertEquals("cmd-1",merged.admission()["commandId"]?.jsonPrimitive?.content)
        assertEquals("outcome_unknown",merged.admission()["outcome"]?.jsonPrimitive?.content)
        assertEquals(false,merged.admission()["retryEligible"]?.jsonPrimitive?.boolean)
    }
    @Test fun aSuccessorResetsOldRejectionButUnknownCannotUndoSameAttemptRejection() {
        val unknown=value(1,"outcome_unknown","outcome_unknown")
        assertEquals("outcome_unknown",mergeFirstPreparation(value(),unknown)["state"]?.jsonPrimitive?.content)
        assertEquals("admission_failed",mergeFirstPreparation(value(1),unknown)["state"]?.jsonPrimitive?.content)
    }
    @Test fun globalStopKeepsSuccessorOutcomeUnknownAndLateAdmissionStillAdvances() {
        val merged=mergeFirstPreparation(value(1,"outcome_unknown","outcome_unknown"),value(0,"stopped","not_admitted",true))
        assertEquals("stopped",merged["state"]?.jsonPrimitive?.content)
        assertEquals("outcome_unknown",merged.admission()["outcome"]?.jsonPrimitive?.content)
        assertEquals(true,merged.admission()["stopConfirmed"]?.jsonPrimitive?.boolean)
        val accepted=mergeFirstPreparation(merged,value(1,"admitted","admitted"))
        assertEquals("admitted",accepted["state"]?.jsonPrimitive?.content)
        assertEquals(true,accepted.admission()["stopConfirmed"]?.jsonPrimitive?.boolean)
    }
    @Test fun deletionWinsEvenAgainstNewerAttemptAndMappingFactsAreMonotonic() {
        val deleted=value(0,"cancelled")
        assertEquals("cancelled",mergeFirstPreparation(value(1),deleted)["state"]?.jsonPrimitive?.content)
        assertEquals("cancelled",mergeFirstPreparation(deleted,value(2))["state"]?.jsonPrimitive?.content)
    }
    @Test fun invalidOrdinalsAndIdentitySwapsAreRefused() {
        try {firstAttemptNumber(value(-1));fail("negative")}catch(_:IllegalArgumentException){}
        val swap=JsonObject(value()+ ("messageAdmission" to JsonObject(value().admission()+("commandId" to JsonPrimitive("other")))))
        try {mergeFirstPreparation(value(),swap);fail("swap")}catch(_:IllegalArgumentException){}
    }
}
