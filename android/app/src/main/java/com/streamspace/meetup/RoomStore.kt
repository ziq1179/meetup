package com.streamspace.meetup

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray

/** A meeting room the user has joined. */
data class RoomEntry(val room: String, val joinedAt: Long)

/**
 * Persists the list of rooms the user has joined, so any room opened through a
 * shared link ("?room=...") shows up on the home screen and can be rejoined.
 */
object RoomStore {
    private const val PREFS = "meetup_rooms"
    private const val KEY_ROOMS = "rooms"
    private const val MAX_ROOMS = 12

    private fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    @Synchronized
    fun saveRoom(context: Context, room: String) {
        val trimmed = room.trim()
        if (trimmed.isEmpty()) return
        val rooms = listRooms(context)
            .filter { it.room != trimmed }
            .toMutableList()
        rooms.add(0, RoomEntry(trimmed, System.currentTimeMillis()))
        while (rooms.size > MAX_ROOMS) rooms.removeAt(rooms.size - 1)

        val arr = JSONArray()
        for (r in rooms) {
            arr.put(
                org.json.JSONObject().apply {
                    put("room", r.room)
                    put("joinedAt", r.joinedAt)
                }
            )
        }
        prefs(context).edit().putString(KEY_ROOMS, arr.toString()).apply()
    }

    fun listRooms(context: Context): List<RoomEntry> {
        val raw = prefs(context).getString(KEY_ROOMS, "[]") ?: "[]"
        return try {
            val arr = JSONArray(raw)
            (0 until arr.length()).mapNotNull { i ->
                val obj = arr.getJSONObject(i)
                val room = obj.optString("room", "")
                if (room.isEmpty()) null else RoomEntry(room, obj.optLong("joinedAt", 0L))
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    @Synchronized
    fun removeRoom(context: Context, room: String) {
        val rooms = listRooms(context).filter { it.room != room }
        val arr = JSONArray()
        for (r in rooms) {
            arr.put(
                org.json.JSONObject().apply {
                    put("room", r.room)
                    put("joinedAt", r.joinedAt)
                }
            )
        }
        prefs(context).edit().putString(KEY_ROOMS, arr.toString()).apply()
    }
}
