# Recording Save Location

## Where Recordings Are Saved

Recordings are saved to your **browser's default Downloads folder** using the browser's download mechanism.

### Default Locations by Browser:

- **Chrome/Edge (Windows)**: `C:\Users\[YourUsername]\Downloads\`
- **Chrome/Edge (Mac)**: `~/Downloads/`
- **Firefox (Windows)**: `C:\Users\[YourUsername]\Downloads\`
- **Firefox (Mac)**: `~/Downloads/`
- **Safari (Mac)**: `~/Downloads/`

### Filename Format

Recordings are saved with this format:
```
recording-[RoomName]-[Timestamp].webm
```

Example:
```
recording-Dars E Quraan-1706123456789.webm
```

Where:
- `[RoomName]` = The name of the meeting room
- `[Timestamp]` = Unix timestamp (milliseconds since epoch)

### How It Works

1. When you click "Stop Recording", the recording is processed
2. A download is automatically triggered by the browser
3. The file is saved to your Downloads folder
4. You'll see the download in your browser's download bar/notification

### Finding Your Recording

1. **Check browser downloads**:
   - Look at the bottom of your browser for a download notification
   - Click on it to open the file location

2. **Open Downloads folder**:
   - Windows: Press `Win + R`, type `%USERPROFILE%\Downloads`, press Enter
   - Mac: Press `Cmd + Option + L` or go to Finder → Downloads
   - Or manually navigate to your Downloads folder

3. **Search for the file**:
   - Search for files starting with `recording-`
   - Sort by date to find the most recent

### File Format

- **Format**: WebM (`.webm`)
- **Codec**: VP8/VP9 video + Opus audio
- **Playback**: Can be played in:
  - Chrome, Firefox, Edge browsers
  - VLC Media Player
  - Most modern video players

### Tips

- The download happens automatically - no need to choose a location
- If your browser asks where to save, you can choose a different location
- Large recordings may take a moment to process before downloading
- Check your browser's download settings if files aren't appearing

### Troubleshooting

**Recording not downloading?**
- Check browser download settings
- Make sure pop-ups aren't blocked
- Check if Downloads folder has write permissions
- Look in browser's download history

**Can't find the file?**
- Check browser's download history (Ctrl+J or Cmd+Shift+J)
- Search your computer for `.webm` files
- Check if browser is set to ask where to save each file
