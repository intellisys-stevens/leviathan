package collector

import (
	"time"

	"github.com/miglens/miglens/internal/history"
)

func historyForTest() *history.Buffer { return history.New(time.Minute, time.Second) }
