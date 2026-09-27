package app

import "time"

// Poll timing: every PollInterval while things answer; after consecutive
// failures (finch not answering, the hub unreachable) the wait doubles up to
// MaxBackoff, so a laptop on a plane is not waking finch every ten seconds.
// Opening the menu always refreshes, but no more often than MinRefreshGap.
const (
	PollInterval  = 10 * time.Second
	MaxBackoff    = 5 * time.Minute
	MinRefreshGap = 2 * time.Second
)

// NextDelay is the wait before the next poll after failures consecutive
// failed polls (0 after a good one).
func NextDelay(failures int) time.Duration {
	d := PollInterval
	for i := 0; i < failures && d < MaxBackoff; i++ {
		d *= 2
	}
	if d > MaxBackoff {
		d = MaxBackoff
	}
	return d
}
